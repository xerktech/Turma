#!/usr/bin/env python3
"""Turma agent safety guard — a Claude Code ``PreToolUse`` hook.

Sessions run the agent hands-off (``--permission-mode auto`` by default, or
``bypassPermissions`` when an operator picks it) so it can do whatever a task
needs (read, write, run builds/tests, git, network) with little or **no**
per-tool approval round-trip. This hook is the backstop that makes that safe: it
inspects every Bash tool call *before* it runs and blocks only four narrow
categories.

1. **destructive** — commands that would wreck the whole repository or the host
   machine: ``rm -rf`` of ``/``/home/system paths or ``.git``, disk wipes
   (``mkfs``/``dd of=/dev/...``/``format``), fork bombs, host power-state
   changes, recursive ``chmod``/``chown`` of system roots, git history
   destruction (``branch -D main``, ``filter-branch``, reflog-expire,
   ``reset --hard`` onto a protected branch), database drops
   (``DROP DATABASE``/``TABLE``), and stopping the agent's OWN service — which
   supervises every session on the host, including the one asking. Denied with a
   reason the model self-corrects from. A specific destructive command an operator wants to permit can be
   allowlisted via ``$TURMA_TOOL_GRANTS`` (a CSV of ``Bash(<command>)``
   patterns) — the exact command only, never a blanket grant.

2. **policy** — PR-workflow rules, enforced hard (no override): pushing to or
   deleting ``main``/``master`` directly, and merging any pull/merge request
   (``gh pr merge``, ``glab mr merge``, a GitLab auto-merge push option,
   completing or auto-completing an Azure DevOps PR). Work lands via a PR/MR
   the agent opens but never self-merges.
   Denied with a reason the agent self-corrects from.

3. **attribution** — ``git commit`` / PR commands carrying AI self-attribution
   (``Co-Authored-By: ... Claude``/``Anthropic``, ``Generated with Claude``,
   the robot emoji, ``noreply@anthropic.com``). Denied with a reason so the
   agent rewrites the message and continues. Disable with
   ``$TURMA_NO_ATTRIBUTION=0``.

4. **pr-summary** — opening a PR/MR (or rewriting its description) whose
   description lacks the sections of the PR summary standard, or of the repo's
   own PR template when it has one. Denied with a reason naming the missing
   sections. Disable with ``$TURMA_PR_SUMMARY=0``.

Everything else is allowed (the hook exits 0 silently, deferring to the normal
— here, bypass — flow).

Contract (Claude Code ``PreToolUse`` hook):
  stdin  — JSON with ``tool_name``, ``tool_input`` (``.command`` for Bash),
           ``session_id``, ``cwd``, ``permission_mode``.
  deny   — print ``{"hookSpecificOutput": {"hookEventName": "PreToolUse",
           "permissionDecision": "deny", "permissionDecisionReason": ...}}``
           and exit 0. The reason is fed back to the model.
  allow  — exit 0 with no output. The one exception is a consumed permission
           judge grant (XERK-1566, ``consume_grant``): an explicit
           ``permissionDecision: allow``, emitted only for a command every
           check above already allowed.

Stdlib only: this file is invoked by absolute path with the session's worktree
as cwd, so it cannot rely on any package being importable.
"""

from __future__ import annotations

import ast
import bisect
import fnmatch
import functools
import hashlib
import itertools
import math
import json
import os
import posixpath
import re
import shlex
import string
import stat
import sys
import threading
import time
from typing import NamedTuple

# --- command segmentation ------------------------------------------------

# Shell operators that chain separate commands. We inspect each segment so a
# destructive command hidden after `&&`/`;`/`|`/`&`/newline is still caught.
# A single `&` backgrounds the command before it — it separates two commands
# exactly like `;` does, so leaving it out let `sleep 0 & rm -rf /etc` past.
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|&]")

# A leading `FOO=bar` environment assignment on a command. It is matched
# against the DEQUOTED token, so the value may hold anything — whitespace and
# newlines included (`CFLAGS="-O2 -g" make`, XERK-1620). `\S*` left such a
# token as the program word and hid the real command behind it. `+=` and a
# subscript (`a[0]=x`, `a[b[1]]=x`) are assignment words too: bash still runs
# the command.
_ENV_ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[.*?\])?\+?=.*\Z", re.DOTALL)

# Privilege-escalation prefixes we strip before classifying the real command
# (a destructive command is destructive with or without `sudo`).
_PREFIX_WORDS = {
    "sudo", "doas", "runas", "command", "nohup", "time", "exec", "env",
    "timeout", "nice", "ionice", "setsid", "stdbuf", "chrt", "unbuffer", "builtin",
    # `coproc cmd` runs cmd (XERK-1624).
    "coproc",
    # `busybox rm -rf /etc` runs its applet; busybox's own `-c` reading is
    # kept beside it in `_expand` (XERK-1687).
    "busybox",
}

# Options of those wrappers that consume the NEXT token as their value, so
# `sudo -u root rm -rf /` strips down to `rm -rf /` rather than stopping at
# `-u` and classifying nothing. Scoped per wrapper: `env -i` takes no value,
# and treating it as if it did swallowed the `rm` that followed.
# Read the way getopt reads them (`_opt_takes_next`): a short cluster takes
# the next token when its LAST value letter ends it (`sudo -nu root`), and a
# long option may be abbreviated (`timeout --kill 1`) — matching only whole
# spellings left the value read as the program (XERK-1627).
_PREFIX_OPTS_WITH_VALUE = {
    "sudo": {"-u", "-g", "-p", "-C", "-h", "-R", "-U", "-r", "-t", "-D", "-T",
             "-a", "-c", "--user", "--group", "--prompt", "--close-from",
             "--host", "--chroot", "--other-user", "--role", "--type", "--chdir",
             "--command-timeout", "--auth-type", "--login-class"},
    "doas": {"-u", "-C", "-a"},
    "env": {"-u", "--unset", "-C", "--chdir"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "nice": {"-n", "--adjustment"},
    "ionice": {"-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid",
               "--pgid", "--uid"},
    "chrt": {"-p", "-T", "-P", "-D", "--sched-runtime", "--sched-period",
             "--sched-deadline"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "setsid": set(),
    # GNU `/usr/bin/time -o FILE`, and `exec -a NAME cmd`.
    "time": {"-f", "--format", "-o", "--output"},
    "exec": {"-a"},
}

# Valueless long options that PREFIX a value-taking one: getopt_long takes an
# exact match over the longer option, so `sudo --login rm` runs `rm` — read as
# `--login-class`, it swallowed the program (XERK-1627 QA).
_PREFIX_LONG_FLAGS = {"sudo": {"--login"}}

# Shell keywords that can lead a segment once `for`/`if`/`while` bodies are
# split on `;` — without these, `do`/`then` becomes the classified program.
_SHELL_KEYWORDS = {
    "do", "done", "then", "else", "elif", "fi", "in", "esac", "!",
    "{", "}", "(", ")", ";;", "if", "while", "until",
}

# Words that may come before a command's leading assignments: `time X=… cmd`.
_PREFIX_KEYWORDS = _SHELL_KEYWORDS | {"time"}

# Compound-statement heads whose word list runs up to `in` — without skipping
# it, `case x in x) rm -rf /etc;; esac` classified as the program `x`.
_WORDLIST_HEADS = {"for", "case", "select"}

# `f()` in `f() { rm -rf /etc; }`, and `x)` in a case arm. Both lead a segment
# whose real command follows them. bash (outside POSIX mode) takes any word as a
# function name — `a-b`, `1f`, `f/g` — and zsh takes none at all: `() { …; }` is
# an anonymous function run on the spot. A narrower name class let those headers
# hide the body (XERK-1633). zsh even takes a quoted one — `'f g'(){ …; }` —
# so any word ending in `()` counts: dropping one only uncovers more to read.
_FUNC_DEF_RE = re.compile(r".*\(\)$", re.DOTALL)
_CASE_PATTERN_RE = re.compile(r"^[^()\s]+\)$")

# Interpreters whose `-c <string>` argument is a whole command line of its own.
# BusyBox's own shells are among them: `busybox` is a stripped wrapper, so
# `busybox hush -c '…'` reaches here as `hush` (XERK-1687).
_SHELL_PROGS = {"bash", "sh", "zsh", "ksh", "dash", "ash", "hush", "msh", "busybox", "su"}

# Programs that merely PRINT their arguments. `eval "$(echo rm -rf /etc)"` runs
# what the substitution printed, so the echo has to be peeled off to see it.
_ECHO_PROGS = {"echo", "printf"}

# Command substitutions, backticks and process substitutions all run their
# contents as a command — `cat <(rm -rf /etc)` runs the `rm` just as surely as
# `$(...)` does.
_SUBST_RE = re.compile(r"\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|>\(([^()]*)\)")


# Characters that end a shell word.
_WORD_END = set(" \t\n;&|()<>")
# Reserved words after which the next word is again a command position.
# `-p` is `time`'s option, so `time -p { …; }` opens a group at command start
# too (XERK-1628); a non-keyword word anywhere in the run still blocks it.
_CMD_KEYWORDS = {"then", "do", "else", "elif", "if", "while", "until", "time", "!", "{", "-p"}
_CASE_PATTERN_OPEN_RE = re.compile(r"(?:\bin|;;&?|;&)\s*$")


def _word_before(command: str, j: int) -> tuple[str, int]:
    """The word ending at index ``j`` (inclusive) and the index it starts at."""
    k = j
    while k >= 0 and command[k] not in _WORD_END:
        k -= 1
    return command[k + 1:j + 1], k + 1


def _char_before(command: str, i: int) -> str:
    """The last non-blank character before ``i`` ("" at the start)."""
    j = i - 1
    while j >= 0 and command[j] in " \t":
        j -= 1
    return command[j] if j >= 0 else ""


def _at_command_start(command: str, i: int, hops: int = 0) -> bool:
    """Whether the word at ``i`` is where a command begins.

    A reserved word only means something THERE — `echo case`, `x do case`,
    `{case` and `!case` are ordinary words — and reading one where it isn't
    leaves a context open, which swallows the group's closing `)`.
    """
    j = i - 1
    if j < 0 or command[j] in ";&|(\n":
        return True
    if command[j] not in " \t":
        return False
    while j >= 0 and command[j] in " \t":
        j -= 1
    if j < 0 or command[j] in ";&|(\n":
        return True
    word, k = _word_before(command, j)
    return word in _CMD_KEYWORDS and hops < 4 and _at_command_start(command, k, hops + 1)


def _esac_closes(command: str, i: int) -> bool:
    """Whether an `esac` at ``i`` ends the open `case`.

    Looser than `_at_command_start` on purpose: `esac` also follows a pattern's
    `)`, a `}`, `fi`, `done`, `]]` or the bare `in` of an empty case. Reading
    one too EARLY is what the suspect fallback in `_expand_segments` absorbs.
    """
    if i > 0 and command[i - 1] not in " \t\n;&|(){}":
        return False
    j = i - 1
    while j >= 0 and command[j] in " \t":
        j -= 1
    if j < 0 or command[j] in ";&|()\n{}]":
        return True
    word, _ = _word_before(command, j)
    return word in ("fi", "done", "esac", "in") or _at_command_start(command, i)


def _word_at(command: str, i: int, word: str) -> bool:
    end = i + len(word)
    return command.startswith(word, i) and (end >= len(command) or command[end] in _WORD_END)


# A compound command's opener keyword and the reserved word that closes it, so
# the stdin-feed walk can keep `if …; then sh; fi` whole and open its body
# (XERK-1628). `select` is listed for grouping only; the ticket's shapes are
# `if`/`for`/`while`/`until`/`case`.
_COMPOUND_OPENERS = {"if": "fi", "for": "done", "while": "done",
                     "until": "done", "select": "done", "case": "esac"}
_COMPOUND_FIRST = frozenset("fiwusc")  # first letters of the openers


def _compound_opener(command: str, i: int) -> str:
    """The compound-command keyword opening at ``i`` (`if`/`for`/…), or ""."""
    if command[i:i + 1] not in _COMPOUND_FIRST:
        return ""
    for kw in _COMPOUND_OPENERS:
        if _word_at(command, i, kw) and _at_command_start(command, i):
            return kw
    return ""


def _compound_closes(command: str, i: int, closer: str) -> bool:
    """Whether ``closer`` (`fi`/`done`/`esac`) at ``i`` ends its compound."""
    if not _word_at(command, i, closer):
        return False
    if closer == "esac":
        return _esac_closes(command, i)
    # `fi`/`done` close only at a command boundary, as bash reads them
    # (`then echo x; fi`, `do …; done >f`, a newline, a group's `)`/`}`).
    return _char_before(command, i) in ("", ";", "&", "|", "\n", ")", "}")


def _is_comment(command: str, i: int, comment_nl: int = -1) -> bool:
    """`#` starts a comment only at the start of an UNESCAPED word.

    ``comment_nl`` is where the caller's last comment ended: a `\\` there was
    the comment's text, never a continuation, so `# c\\` NL `# d` is two
    comments. Read as `a\\<newline>#`, the second `#` was a word and its
    `'` a quote that hid the commands after it (`rm -rf /etc`, QA)."""
    if i == 0:
        return True
    prev = command[i - 1]
    # Not after `)`: `$(x)#…`, `<(x)#…` and `$((1))#…` CONTINUE the word, so
    # bash runs what follows. After a subshell's `)` it would be a comment;
    # reading it as text there can only classify more.
    if prev in ";&|(":
        return True
    # `a\ #` is one word, `a\<newline>#` is `a#`: an escaped blank is no break.
    # An EVEN backslash run before the blank is literal text, then a break (QA).
    if prev not in " \t\n":
        return False
    k = i - 2
    while k >= 0 and command[k] == "\\":
        k -= 1
    return (i - 2 - k) % 2 == 0 or i - 1 == comment_nl


def _balanced_groups(command: str, heredoc: bool = False) -> tuple[list[str], bool]:
    """Bodies of the outermost `$(…)`, `<(…)`, `>(…)`, `(…)` and backtick groups,
    and whether the scan is SUSPECT.

    `_SUBST_RE` only ever sees ONE segment, and segmenting happens first, so a
    group holding `;`, `|` or `&&` was cut in half before it could match:
    `echo $(true; rm -rf /)` became `echo $(true` and `rm -rf /)`, whose last
    token `/)` is no path at all — and `(cd /tmp; rm -rf /)` likewise (XERK-1083).
    Matching parens over the WHOLE command keeps each body intact so it can be
    expanded on its own terms; nesting is left to that recursion.

    A paren that is not a group must not open or close one, so this is a
    small lexer; each context below was a bypass or a false deny:
    - `'…'` and `$'…'` are literal (`$'\\''` holds an escaped quote).
    - Inside `"…"`, `[[ … ]]` and `${…}` only `$(`, `${` and backticks open
      anything — a bare paren is text, regex or a pattern (`[[ $x =~ (a|b) ]]`).
    - Inside `case … esac` a `)` ends a PATTERN, and a `(` right after `in`
      or `;;` is the optional pattern opener (`case $x in (a|b) …`).
    - `#` at the start of an unescaped word runs to the end of the line.

    No lexer short of bash's own is exact, so the scan reports when it lost
    track — a context still open at the end, or a `)` closing nothing outside a
    `case` — and the caller then also classifies the operator-split fragments
    with their stray group edges stripped. A misread fails CLOSED that way,
    where on its own it swallowed the group's `)` and extracted nothing.
    An unclosed group yields no body: reading it to the end of the string
    swallowed later commands into it.

    ``heredoc`` scans the body of an UNQUOTED heredoc, which bash expands like
    a double-quoted string whose `"` is literal (XERK-1256): only `$(`, `${` and
    backticks open anything, so `don't $(rm -rf /)` still runs its group.
    """
    bodies: list[str] = []
    # One entry per open context: '"' a double-quoted string, 'p' a `${…}`,
    # '[' a `[[ … ]]` test, 'c' a `case … esac`, '(' a group. Quoting nests
    # inside `$(…)`, so a flat flag cannot tell `"$(grep "a)" f)"` from `"a)"`.
    # 'h' (heredoc mode only) is the body itself; nothing closes it.
    base = ["h"] if heredoc else []
    stack: list[str] = list(base)
    suspect = False
    start = 0
    i, n = 0, len(command)

    def skip_single(j: int, ansi: bool) -> int:
        """Index just past the `'` closing a quote whose opener is at ``j``."""
        j += 1
        while j < n and command[j] != "'":
            j += 2 if ansi and command[j] == "\\" else 1
        return j + 1

    def open_group(j: int) -> None:
        nonlocal start
        if "(" not in stack:
            start = j
        stack.append("(")

    comment_nl = -1  # where the last comment ended (`_is_comment`)
    while i < n:
        ch = command[i]
        top = stack[-1] if stack else ""
        if ch == "\\":
            i += 2
            continue
        if ch == "`":
            end = i + 1
            while end < n and command[end] != "`":
                end += 2 if command[end] == "\\" else 1
            if end >= n:
                suspect = True
            if "(" not in stack:
                bodies.append(command[i + 1:end])
            i = end + 1
            continue
        if ch == "$" and command[i + 1:i + 2] == "(":
            open_group(i + 2)
            i += 2
            continue
        if ch == "$" and command[i + 1:i + 2] == "{":
            stack.append("p")
            i += 2
            continue
        if top in ('"', "h"):
            if ch == '"' and top == '"':
                stack.pop()
            i += 1
            continue
        if ch == "$" and command[i + 1:i + 2] == "'":
            i = skip_single(i + 1, ansi=True)
            continue
        if ch == "'":
            i = skip_single(i, ansi=False)
            continue
        if ch == '"':
            stack.append('"')
            i += 1
            continue
        if top == "p":
            if ch == "}":
                stack.pop()
            i += 1
            continue
        if top == "[":
            if command.startswith("]]", i):
                stack.pop()
                i += 2
                continue
            i += 1
            continue
        if ch == "#" and _is_comment(command, i, comment_nl):
            end = command.find("\n", i)
            i = comment_nl = n if end < 0 else end
            continue
        if _word_at(command, i, "[[") and _at_command_start(command, i):
            stack.append("[")
            i += 2
            continue
        if _word_at(command, i, "case") and _at_command_start(command, i):
            stack.append("c")
            i += 4
            continue
        if top == "c" and _word_at(command, i, "esac") and _esac_closes(command, i):
            stack.pop()
            i += 4
            continue
        if ch == "(":
            if top == "c" and _CASE_PATTERN_OPEN_RE.search(command[max(0, i - 64):i]):
                i += 1  # the optional `(` before a case pattern; its `)` ends it
                continue
            open_group(i + 1)
        elif ch == ")":
            if top == "(":
                stack.pop()
                if "(" not in stack:
                    bodies.append(command[start:i])
            elif top != "c":
                suspect = True  # closes nothing: some context was misread
        i += 1
    return [b for b in bodies if b.strip()], suspect or stack != base


# The ends a group leaves on an operator-split fragment: `rm -rf /)` is the
# tail of `$(true; rm -rf /)`, `echo $(rm -rf /` its head.
_GROUP_TAIL_RE = re.compile(r"[)`\s]+\Z")
_GROUP_HEAD_RE = re.compile(r"\A(?:\$\(|[<>]\(|[(`\s])+")
_GROUP_OPEN_RE = re.compile(r"\$\(|[<>]\(|\(|`")


def _stray_group_fragments(segment: str) -> list[str]:
    """``segment`` with a group's severed edges cut off, when it has any."""
    s = segment.strip()
    trimmed = _GROUP_HEAD_RE.sub("", _GROUP_TAIL_RE.sub("", s))
    out = [trimmed] if trimmed and trimmed != s else []
    opens = list(_GROUP_OPEN_RE.finditer(trimmed))
    if opens:
        tail = trimmed[opens[-1].end():].strip()
        if tail:
            out.append(tail)
    return out


def _subst_inner(m: "re.Match[str]") -> str:
    """The command text inside whichever substitution form matched."""
    return next((g for g in m.groups() if g), "")


# Stands in for a substitution whose OUTPUT cannot be known. It must be
# non-empty and path-shaped-but-harmless: blanking a substitution left
# `rm -rf "$(mktemp -d)"` with an empty target, and an empty target read as the
# filesystem root — refusing the standard temp-dir cleanup idiom.
_OPAQUE_SUBST = "turma_substituted_value"

# The special parameters that can expand to NOTHING: positional ones and `$!`
# with no background job. `$$`, `$#`, `$?`, `$-` and `$0` always print text.
_MAYBE_EMPTY_SPECIAL = set("@*123456789!")


def _param_spans(text: str) -> list[tuple[int, int, str]]:
    """Every live parameter expansion still in ``text``, as (start, end, kind).

    By the time a segment is read, `_substitute_vars` has spliced each name the
    line assigns, so whatever is left is one this line never set: `"param"`
    (`$x`, `${x#a}`, `${a[@]}`, `${!a@}`, `$@`), `"locale"` for the `$` of a
    bare `$"…"` (a translated string, which reads as the string), and
    `"opaque"` for `_OPAQUE_SUBST`, a substitution whose output is unknown.
    `${#x}` (a length) never expands to nothing, so it is not one.

    One pass: only the LAST `$` of a run can start a name (the others pair
    into `$$`), so liveness is asked once per run. Asking per `$` rescanned
    the run each time, quadratic in a line of `$`s past the hook timeout.
    """
    if "$" not in text and _OPAQUE_SUBST not in text:
        return []
    states = _quote_states(text)
    out: list[tuple[int, int, str]] = []
    n, i = len(text), 0
    opaque = text.find(_OPAQUE_SUBST)
    while i < n:
        if i == opaque:
            out.append((i, i + len(_OPAQUE_SUBST), "opaque"))
            i += len(_OPAQUE_SUBST)
            opaque = text.find(_OPAQUE_SUBST, i)
            continue
        if text[i] != "$":
            # Straight to the next `$` or placeholder: a per-character scan
            # was most of a long line's time.
            dollar = text.find("$", i)
            i = n if dollar < 0 else dollar
            if 0 <= opaque < i:
                i = opaque
            continue
        while i + 1 < n and text[i + 1] == "$":
            i += 1
        if i + 1 >= n or states[i] in ("'", "\\") or not _live_dollar(text, i):
            i += 1
            continue
        nxt = text[i + 1]
        end = -1
        if nxt == "{" and not text.startswith("${#", i):
            close = _brace_end(text, i, states[i] == '"')
            end = close + 1 if close > 0 else -1
        elif nxt.isalpha() or nxt == "_":
            end = i + 2
            while end < n and (text[end].isalnum() or text[end] == "_"):
                end += 1
        elif nxt in _MAYBE_EMPTY_SPECIAL:
            end = i + 2
        elif nxt == '"' and states[i] == "":
            out.append((i, i + 1, "locale"))
        if end > 0:
            out.append((i, end, "param"))
            i = end
        else:
            i += 1
    return out


# A list expansion: NO word at all when empty, even quoted — `"$@"`,
# `"${@:2}"`, `"${a[@]/x}"`, `"${!a[@]}"`, `"${!a@}"`. `"$*"` is one word.
_QUOTED_NO_WORDS_RE = re.compile(
    r"^\$(?:@|\{(?:!?(?:@|[A-Za-z_]\w*\[@\])|![A-Za-z_]\w*@)[^}]*\})$")

# How many leading words `_unset_readings` reads before it finds the program:
# each costs a tokenise of the words before it. Past it, a line that dropped
# an empty word is too deep (denied); one that dropped none has no reading.
_MAX_EMPTY_PROGRAM_WORDS = 64


def _unset_readings(seg: str) -> list[str]:
    """`_unset_readings_of`, each reading charged to the growth budget: every
    one is re-expanded, at every depth an eval or `-c` adds, so unbudgeted
    their fan-out ran a 98 KB line past the hook timeout (XERK-1615 QA)."""
    out = _unset_readings_of(seg)
    _spend(sum(map(len, out)))
    return out


def _unset_readings_of(seg: str) -> list[str]:
    """``seg`` with each expansion that may be EMPTY read as empty, where the
    empty reading runs a different command (XERK-1609, XERK-1615).

    Two readings, each only ADDED to the ones the caller already has:
    - Glued: an unset name glued to word text leaves that text, so `${x#a}rm`,
      `"$x"\\rm`, `$@rm` and `$""rm` all run `rm`. Only a word character, a
      backslash or another expansion is glue: `"$dir"/*` and `"$repo".git` are
      paths, and reading them as `/*` and `.git` denied ordinary cleanup.
    - Program: a COMMAND word made only of unquoted unset names, unknown-output
      substitutions and quoted list expansions is no word at all, and bash runs
      the next one as the program: `$x rm`, `$(true)$(true) rm`, `"$@" rm`.
      A quoted `"$x"` is a word (bash runs `""`). A whole-word argument is
      left alone: `rm -rf "$d"` passes an empty argument, and the guard reads
      an empty target as the root.
    A name this line assigns is never read empty: `R=$(command -v ruff); $R
    check` names whatever R holds. The one clash is a tool path followed by
    its `format` subcommand (ruff, black, cargo, terraform, clang-format), so
    a revealed `format` counts only with the drive letter the Windows
    formatter needs.

    Both passes are linear in ``seg``: rebuilding the text per removal, or
    tokenising every word's prefix, ran a 30 KB line toward the hook's
    timeout, which fails OPEN (XERK-1615 QA).
    """
    spans = _param_spans(seg)
    if not spans:
        return []
    # Glued, right to left: `nxt` is the first character after a span once
    # quotes and the removed spans after it are skipped, so `${x}${y}rm`
    # sees `${x}` glued once `${y}` is gone.
    removed: list[tuple[int, int]] = []
    nxt, nxt_at = "", len(seg)
    for start, end, kind in reversed(spans):
        j = end
        while j < len(seg) and seg[j] in "\"'":
            j += 1
        after = nxt if j == nxt_at else seg[j:j + 1]
        if kind == "locale" or (kind == "param" and (after.isalnum() or after in ("_", "\\", "$", "`"))):
            removed.append((start, end))
            nxt, nxt_at = after, start
            continue
        nxt, nxt_at = seg[start], start
    pieces, last = [], 0
    for start, end in reversed(removed):
        pieces.append(seg[last:start])
        last = end
    pieces.append(seg[last:])
    cur = "".join(pieces)
    out = [cur] if cur != seg else []
    # Program, over the segment as written and as glued: removing glued
    # spans first turned `"$@""$@" rm` into `"""$@" rm`, which is a word.
    for text in dict.fromkeys((seg, cur)):
        prog = _empty_program_dropped(text)
        if prog is None or prog in out:
            continue
        if prog == _TOO_DEEP:
            return [_TOO_DEEP]
        toks = _strip_prefixes(_tokenize(prog))
        if not (toks and _basename(toks[0]) == "format"
                and not any(re.match(r"^[A-Za-z]:", t) for t in toks[1:])):
            out.append(prog)
    return out


def _empty_program_dropped(cur: str) -> str | None:
    """``cur`` with its leading words that may be EMPTY dropped, else None
    (see `_unset_readings`). Left to right over the words at the front of the
    command: an empty one is dropped, a prefix word (`sudo`, `env a=1`) kept,
    and the first real program word ends the walk."""
    at = {start: (end, kind) for start, end, kind in _param_spans(cur)}
    states = _quote_states(cur)
    n, pos, dropped = len(cur), 0, False
    words: list[str] = []
    kept: list[str] = []
    for _ in range(_MAX_EMPTY_PROGRAM_WORDS):
        a = pos
        while a < n and cur[a] in " \t":
            a += 1
        if a >= n:
            break
        p = a
        while p < n:
            if p in at and at[p][1] != "locale" and states[p] == "":
                p = at[p][0]
            elif cur[p] == '"' and p + 1 in at and at[p + 1][0] < n \
                    and cur[at[p + 1][0]] == '"' \
                    and _QUOTED_NO_WORDS_RE.match(cur[p + 1:at[p + 1][0]]):
                p = at[p + 1][0] + 1
            else:
                break
        if p > a and (p == n or (cur[p] in _WORD_END and states[p] == "")):
            kept.append(cur[pos:a])
            pos, dropped = p, True
            continue
        e = a
        while e < n and not (cur[e] in " \t\n" and states[e] == ""):
            e += 1
        words.extend(_tokenize(cur[a:e]))
        if _strip_prefixes(words):
            break
        kept.append(cur[pos:e])
        pos = e
    else:
        # Out of words to read with no program found. A partial reading here
        # re-read the next 64 at every depth, unbudgeted, past the hook
        # timeout (XERK-1615 QA); no one writes 64 empty words, so deny.
        # 64 plain prefix words (`A=1 B=2 …`) with none dropped are no reading.
        return _TOO_DEEP if dropped else None
    return "".join(kept) + cur[pos:] if dropped else None


# How many substitutions in one segment may each get a reading of their own
# (see `_decoy_readings`); a segment with more is read as too deep, which denies.
_MAX_DECOY_SUBSTS = 16


def _decoy_readings(raw: str) -> list[str]:
    """``raw`` read once per substitution whose printed text differs as the
    literal word (`_literal`): that one read plain, every other one literal.

    The plain reading is what a shell re-parsing the text runs, and the
    literal one is the word bash splices in. Reading a whole segment one way
    let a SIBLING decide it (XERK-1615): in `bash -c "$(echo "''rm …")" "$(echo
    '"')"` the plain reading leaves the second's `"` to unbalance the line, and
    the literal one escapes the first's `''` that `bash -c` would strip. One
    reading per substitution covers each being the re-parsed one without
    trying every combination. More than `_MAX_DECOY_SUBSTS` fails closed.
    """
    if raw.count("$(") + raw.count("`") < 2:
        return []
    found = _find_substs(raw)
    if len(found) < 2:
        return []
    differ = [m.start() for m in found
              if _subst_text(m) != _subst_text(m, literal=True)]
    if len(differ) < 2:
        # The caller's all-plain and all-literal readings already cover it.
        return []
    if len(differ) > _MAX_DECOY_SUBSTS:
        return [_TOO_DEEP]
    # Each reading re-expands the whole segment: charged to the growth budget,
    # so a long line of them is too large, never past the hook timeout.
    _spend(len(raw) * len(differ))
    return [_unwrap_group(_sub_substs(
        raw, lambda m, plain=start: _subst_text(m, literal=m.start() != plain)))
        for start in differ]


# Every character `_quote_states` treats specially.
_QUOTE_STATE_CHARS = frozenset("#\\$}`'\"()")


def _ansi_c_dollar(command: str, i: int) -> bool:
    """Whether the `$` at ``i`` (before a `'`) opens an ANSI-C string: not the
    second half of a `$$` (the PID, then a plain `'…'`). bash pairs a `$` run
    left to right, after an escaped first `$` (XERK-1693 QA: `$$'a\\'; rm …`)."""
    j = i
    while j > 0 and command[j - 1] == "$":
        j -= 1
    run = i - j + 1
    k = j
    while k > 0 and command[k - 1] == "\\":
        k -= 1
    if (j - k) % 2:
        run -= 1  # `\$` is a literal dollar
    return run % 2 == 1


def _quote_states(command: str) -> list[str]:
    """How each character of ``command`` is quoted: `'` inside a single-quoted
    literal, `"` inside a double-quoted string, `\\` escaped, "" bare.

    A `$(…)` or backtick body inside a string restarts quoting, as bash does,
    so the `'…'` in `"$(echo 'a')"` is a real single-quoted literal again. A `#` comment is
    `#` to its line's end: the apostrophe in `# don't` opened a "quote" that
    every later character was read inside (XERK-1549).

    A `${…}` nests a string too: in `"${y:-"it's"}"` the inner `"…"` is a
    string of its own, not the outer one closing. Read flat, its `'` opened a
    quote that hid every command after it (XERK-1621). Frames: `{` for a bare
    `${`, `{"` for one inside a string. A `'` directly in a `{"` frame is
    shell-dependent (`_BRACE_OTHER_SHELL`): bash pairs it, hiding a `"` or `}`
    up to the next `'` (its text still expands), while zsh and dash read it
    as a plain character.
    """
    out = [""] * len(command)
    stack: list[str] = []
    i, n = 0, len(command)
    comment_nl = -1  # where the last comment ended (`_is_comment`)
    while i < n:
        ch = command[i]
        top = stack[-1] if stack else ""
        if ch not in _QUOTE_STATE_CHARS:
            # Plain text is quoted as its frame is: most of a long line.
            if top in ('"', '{"'):
                out[i] = '"'
            i += 1
            continue
        if ch == "#" and top in ("", "(") and _is_comment(command, i, comment_nl):
            end = command.find("\n", i)
            end = comment_nl = n if end < 0 else end
            out[i:end] = ["#"] * (end - i)
            i = end
            continue
        if ch == "\\":
            out[i:i + 2] = ["\\"] * len(out[i:i + 2])
            i += 2
            continue
        if command.startswith("$(", i):
            stack.append("(")
            i += 2
            continue
        if command.startswith("${", i) and not _MAIN_PARSE[0] and _live_dollar(command, i):
            quoted = top in ('"', '{"')
            if _bad_brace(command, i) and _BRACE_OTHER_SHELL[0]:
                end = _brace_end(command, i, quoted)
                end = n - 1 if end < 0 else end
                out[i:end + 1] = ['"' if quoted else ""] * (end + 1 - i)
                i = end + 1
                continue
            stack.append('{"' if quoted else "{")
            out[i:i + 2] = ['"' if quoted else ""] * 2
            i += 2
            continue
        if ch == "}" and top in ("{", '{"'):
            # (`_MAIN_PARSE` pushes no such frame.)
            out[i] = '"' if top == '{"' else ""
            stack.pop()
            i += 1
            continue
        if ch == "`":
            # A backtick body ends at the next unescaped backtick, whatever
            # quote or `#` is inside it, and its quoting is its own: in
            # `"\`echo "it's"\`"` the apostrophe is in the body's string, and
            # in `"\`echo # it's\`"` the comment ends at the closer. A frame
            # left open let either swallow the closer (XERK-1615 QA). One
            # never closed is a syntax error to bash; read it as text.
            j = i + 1
            while j < n and command[j] != "`":
                j += 2 if command[j] == "\\" else 1
            if j < n:
                out[i + 1:j] = _quote_states(command[i + 1:j])
                i = j + 1
                continue
        if command.startswith("$'", i) and top in ("", "(", "{") and _ansi_c_dollar(command, i):
            # An ANSI-C string: `\` escapes the next character, so the `\'`
            # in `$'it\'s'` is text, not its close. Read as a plain `'…'`, its
            # `s'` opened a quote that hid every later `$'…'` (XERK-1693 QA).
            j = i + 2
            while j < n and command[j] != "'":
                j += 2 if command[j] == "\\" else 1
            end = min(j, n - 1)
            out[i + 1:end + 1] = ["'"] * (end - i)
            i = end + 1
            continue
        if top == '"':
            out[i] = '"'
            if ch == '"':
                stack.pop()
            i += 1
            continue
        if top in ("{", '{"') and ch in "'\"":
            _MAIN_PARSE_SEEN[0] = True
        if top == '{"':
            # Inside a string's `${…}`: a nested `"…"` quotes, and a `'`
            # pairs in bash. Either way the text stays string text: bash
            # still expands `$x` and `$(…)` between those `'`.
            if ch == "'":
                _BRACE_OTHER_SEEN[0] = True
            if ch == "'" and not _BRACE_OTHER_SHELL[0]:
                end = command.find("'", i + 1)
                end = n - 1 if end < 0 else end
                out[i:end + 1] = ['"'] * (end + 1 - i)
                i = end + 1
                continue
            out[i] = '"'
            if ch == '"':
                stack.append('"')
            i += 1
            continue
        if ch == "'":
            end = command.find("'", i + 1)
            end = n - 1 if end < 0 else end
            out[i:end + 1] = ["'"] * (end + 1 - i)
            i = end + 1
            continue
        if ch == '"':
            out[i] = '"'
            stack.append('"')
        elif ch == "(" and top != "{":
            stack.append("(")
        elif ch == ")" and top == "(":
            stack.pop()
        i += 1
    return out


def _subst_standalone(m: "re.Match[str]") -> bool:
    """Whether the substitution is a whole word of its own (quotes aside)."""
    s, a, b = m.string, m.start(), m.end()
    while a > 0 and s[a - 1] in "'\"":
        a -= 1
    while b < len(s) and s[b] in "'\"":
        b += 1
    return (a == 0 or s[a - 1] in _WORD_END) and (b == len(s) or s[b] in _WORD_END)


def _printed_text(command: str) -> str | None:
    """What ``command`` prints when it only prints its arguments (echo, or
    printf rendered as printf would), else None. `command echo`, `exec echo`
    and the like print just the same. A bad substitution prints nothing
    (see `_stmt_printed`)."""
    if "${" in command and not _MAIN_PARSE[0] and _BAD_SUBST_RE.search(command):
        return None
    return _printed_from_tokens(_strip_prefixes(_tokenize(command)))


def _printed_from_tokens(toks: list[str]) -> str | None:
    """`_printed_text` from an already-tokenised argv, so a caller can strip a
    prefix (`sudo echo …`) without re-joining and corrupting printf's words."""
    if not toks:
        return None
    prog = _basename(toks[0])
    for _ in range(_EVAL_ASSIGN_DEPTH):
        if prog != "eval":
            break
        # `eval echo …` prints what the echo it re-reads prints: opaque,
        # `eval "$(eval echo "a=\\'rm …\\'")"; $a` bound nothing (XERK-1668).
        rest = toks[2:] if toks[1:2] == ["--"] else toks[1:]
        toks = _strip_prefixes(_tokenize(" ".join(rest)))
        if not toks:
            return None
        prog = _basename(toks[0])
    if prog == "printf":
        name, rest = _printf_args(toks)
        return _render_printf(rest[0], rest[1:]) if name is None and rest else ""
    if prog == "yes":
        # `yes WORDS` prints its words line after line (`y` with none); GNU
        # yes drops a leading `--` (XERK-1717). Read as one line of them.
        args = toks[2:] if toks[1:2] == ["--"] else toks[1:]
        return " ".join(args) if args else "y"
    if prog in _ECHO_PROGS:
        args, flags = toks[1:], ""
        while args and re.match(r"^-[neE]+$", args[0]):
            flags += args.pop(0)
        text = " ".join(args)
        return _printf_unescape(text).split(_PRINTF_STOP, 1)[0] if "e" in flags else text
    return None


# How deep `_subst_text` resolves substitutions nested in a body. Deeper
# reads as unknowable output; Python's own recursion limit would raise.
_MAX_SUBST_DEPTH = 32
_SUBST_DEPTH = [0]


# Pipeline stages whose output is (a part of) their input, so a body
# `echo … | head -1` still prints the producer's words.
_PASS_THROUGH = {"cat", "tee", "head", "tail", "sort", "uniq"}


def _passes_input(stage: str) -> bool:
    """Whether a pipeline stage prints (part of) what it reads, not a file's."""
    toks = _strip_prefixes(_tokenize(_unwrap_group(stage)))
    if not toks:
        return False
    prog = _basename(toks[0])
    return prog in _PASS_THROUGH and (prog != "cat" or all(t == "-" for t in toks[1:]))


# A `${` naming no parameter: bash fails the command ("bad substitution").
_BAD_SUBST_RE = re.compile(r"\$\{(?![#!]?(?:[A-Za-z_]|[0-9@*#?$!-]))")
# A `${` naming a parameter and going on to an operator or its `}`.
_GOOD_BRACE_RE = re.compile(r"\$\{[#!]?(?:[A-Za-z_]\w*|[0-9]+|[@*#?$!-])[}:\-=+?#%/^,\[@]")


_DASH_NAME_RE = re.compile(r"[#!]?(?:[A-Za-z_]\w*|[0-9]+|[@*#?$!-])?")


def _dash_bad_body(command: str, i: int) -> int:
    """Where dash goes on reading the bad `${` at ``i``: past its name and
    the one character it takes as the operator, quote or not. So `${''}'}`
    closes at the second `}` (the `'}'` is quoted) and `${a";}"` at the first
    (XERK-1621 QA, measured: dash runs both)."""
    return _DASH_NAME_RE.match(command, i + 2).end() + 1


def _bad_brace(command: str, i: int) -> bool:
    """Whether the `${` at ``i`` is a bad substitution, which shells PARSE
    differently: bash nests quotes inside it as in any `${…}`, dash ends it
    at its first `}`. So `"$(true "${";}")"rm …` splits at the `;` in bash
    and runs `rm` in dash (XERK-1621 QA). Seeing one asks `_expand_both` for
    the other-shell reading (`_BRACE_OTHER_SHELL`), which reads it flat."""
    if _GOOD_BRACE_RE.match(command, i):
        return False
    _BRACE_OTHER_SEEN[0] = True
    return True


def _stmt_printed(stmt: str) -> tuple[str, bool] | None:
    """What one statement prints and whether it ends a line, else None.

    A bad substitution prints nothing, so its text is no output: read as
    printed, `"$(echo "${";}")"rm -rf /` hid the `rm` glued to it
    (XERK-1621). Unknown instead, it may be empty."""
    if "${" in stmt and not _MAIN_PARSE[0] and _BAD_SUBST_RE.search(stmt):
        return None
    stages = _split_segments(stmt)
    if not stages or not all(_passes_input(st) for st in stages[1:]):
        return None
    toks = _strip_prefixes(_tokenize(_unwrap_group(stages[0])))
    text = _printed_from_tokens(toks)
    if text is None:
        return None
    if _basename(toks[0]) == "printf":
        return text, text.endswith("\n")
    return text, not any(re.match(r"^-[neE]*n", t) for t in toks[1:3])


def _statements_printed(body: str) -> str | None:
    """What a body of several statements, or a pipeline, prints.

    Reading only a body that is ONE echo/printf let `$(true; echo rm -rf /etc)`
    and `$(echo rm -rf /etc | cat)` stand as the harmless placeholder while bash
    ran their output as a command (XERK-1609). Each statement's text is
    concatenated as bash prints it — `echo -n r; echo m` is `rm`, and lines
    stay lines, which `eval "$(echo true; echo rm …)"` runs one by one; a pipeline
    counts when every stage after its producer passes its input on, and a
    statement that prints something unknown adds nothing. A body with NO known
    printing statement stays opaque (None): `$(mktemp -d)` must not read as an
    empty word, which is the root.
    """
    # A `(…)`/`{…}` group with trailing redirects prints what the group
    # prints: open it first, so `x=$( (true; echo P) 2>/tmp/f )` reads P and
    # not the split-apart `echo P) 2>/tmp/f` (XERK-1628).
    if body.strip()[:1] in ("(", "{"):
        core = _group_core(body)
        if core is not None:
            body = _unwrap_group(core)
    out, all_known = "", True
    for stmt in _split_on_operators(body, include_pipe=False):
        # The splitter cuts inside a `( …; … )` / `{ …; }` group, so a
        # statement can carry half a group's wrapper.
        stmt = _unwrap_group(stmt).lstrip("( \t").rstrip(") \t")
        known = _stmt_printed(stmt)
        if known is not None:
            out += known[0] + ("\n" if known[1] else "")
        elif _strip_prefixes(_tokenize(stmt)):
            all_known = False
    out = out.strip()
    if out:
        return out
    return "" if all_known else None


def _literal(text: str) -> str:
    """``text`` escaped to read as the literal WORD bash splices in.

    A printed `"` closed the string around its substitution, so `echo "$(true;
    echo '"')"; rm -rf /` read the `rm` as quoted text (XERK-1609). A shell that
    re-parses the text (`bash -c "$(…)"`) does strip those quotes, so this is
    one reading of two, never a replacement for the plain one.
    """
    return re.sub(r'([\\"\'`$])', r"\\\1", text)


@functools.lru_cache(maxsize=1024)
def _body_printed(body: str, raw: tuple, multi: bool = True,
                  assigns: bool = True) -> tuple[str | None, int]:
    """`_printed_text` of a substitution body once its own substitutions are
    resolved, and the escaped ones that skipped (replayed by the caller, as
    `_memo` does). Memoised: every pass over a line re-resolves each nesting
    level beneath it, which on thousands of levels runs past the hook timeout,
    which fails OPEN. ``raw`` is `_reading()`, the flags the resolution reads.

    ``multi`` also reads a body of several statements (`_statements_printed`).
    Without it a body is read as it was before XERK-1609, a reading callers
    keep as well: an opaque body was denied where its printed text is not
    (`eval "$(true; echo '${x#a}')rm …"`), so dropping it lost denies.

    ``assigns=False`` leaves the body's own assignments unapplied: applying
    them also expands a `${…}` the body only PRINTS (`echo 'X=${v:-a b}
    Y=1'`), which hid the assignment cut of XERK-1645."""
    before = _SPLICES_ESCAPED[0]
    resolved = _sub_substs(body, lambda m: _subst_text(m, multi=multi, assigns=assigns))
    if assigns and "=" in resolved and "$" in resolved and _VAR_ASSIGN_RE.search(resolved):
        # The body's own assignments are its uses' values: `$(x='rm …';
        # echo "$x")` prints `rm …`, not `$x` (XERK-1634).
        resolved = _substitute_vars(resolved)
    unwrapped = _unwrap_group(resolved)
    printed = _statements_printed(resolved) \
        if multi and _SEGMENT_SPLIT.search(unwrapped) else None
    if printed is None:
        printed = _printed_text(unwrapped)
    if printed is None and "<(" in body:
        printed = _cat_printed(body)
    return printed, _SPLICES_ESCAPED[0] - before


# Programs that print the files they are given, unchanged.
_CAT_PROGS = {"cat", "tac", "tee", "head", "tail"}
# Their options that take the NEXT word as a value (`head -n 1`).
_CAT_OPTS_WITH_VALUE = {"-n", "-c", "--lines", "--bytes"}


def _cat_printed(body: str) -> str | None:
    """What `cat <(…) …` prints: each `<(…)` operand's text, in order, so
    `bash -c "$(cat <(echo <cmd>))"` runs <cmd> (XERK-1614). So does `< <(…)`,
    with or without `cat` (`$(< <(…))`); `head`/`tail` are read as printing it
    all. None when any operand is something else — a real file's content is
    unknowable. `-` and `/dev/null` add nothing knowable and are skipped."""
    texts: list[list[str]] = []

    def mark(m: "re.Match[str]") -> str:
        if not m.group(0).startswith("<("):
            return _subst_text(m)
        # Each level recurses through `_body_printed`; deeper reads as opaque.
        if _SUBST_DEPTH[0] >= _MAX_SUBST_DEPTH:
            return _OPAQUE_SUBST
        _SUBST_DEPTH[0] += 1
        try:
            texts.append(_proc_subst_texts(_subst_inner(m)))
        finally:
            _SUBST_DEPTH[0] -= 1
        return f"\x00turma-proc-{len(texts) - 1}"

    words = _tokenize(_unwrap_group(_sub_substs(body, mark)))
    marker = re.compile(r"\x00turma-proc-(\d+)")
    # `$(< file)` is bash's `cat file`.
    if words and not _REDIRECT_RE.match(words[0]):
        words = _strip_prefixes(words)
        if not words or _basename(words[0]) not in _CAT_PROGS:
            return None
        words = words[1:]
    out = []
    i = 0
    while i < len(words):
        word = words[i]
        i += 1
        redirect = _REDIRECT_RE.match(word)
        if redirect:
            target = redirect.group(1)
            if not target and i < len(words):
                target, i = words[i], i + 1
            m = marker.fullmatch(target)
            # Only an input redirect feeds the printer; any other is skipped.
            if m and re.match(r"^\d*<(?![<>&])", word):
                out.extend(texts[int(m.group(1))])
            continue
        if word in _CAT_OPTS_WITH_VALUE:
            i += 1
            continue
        if (word.startswith("-") and len(word) > 1) or word in ("-", "/dev/null"):
            continue
        m = marker.fullmatch(word)
        if not m:
            return None
        # Every text the body may print, one per line: over-reading fails closed.
        out.extend(texts[int(m.group(1))])
    return "\n".join(out) if out else None


def _subst_text(m: "re.Match[str]", glued_empty: bool = False, literal: bool = False,
                multi: bool = True, assigns: bool = True) -> str:
    """What a substitution CONTRIBUTES to the command line around it.

    `rm -rf $(echo /etc)` deletes /etc, and erasing the substitution erased the
    target with it — an easier spelling than the `eval "$(echo …)"` form. Where
    the inner command only prints its arguments, those arguments ARE the text;
    anything else is opaque.

    ``glued_empty`` is the other reading of an opaque substitution: that it
    printed NOTHING. Glued to a word, that is the word itself — `$()rm -rf /`
    and `` `true`rm -rf / `` run `rm`, which the placeholder alone hid as the
    program `turma_substituted_valuerm` (XERK-1256). A standalone one stays
    opaque: an empty WORD reads as the root (see `_OPAQUE_SUBST`).

    ``literal`` escapes a `$(…)`'s printed text as the WORD bash splices in; the
    plain text is what a shell re-parsing it runs. A `<(…)` hands its reader a
    path, so it has no word reading. ``multi`` and ``assigns`` are `_body_printed`'s.
    """
    # The body's own substitutions run first, and a subshell prints what its
    # body prints: `` `echo \\`echo …\\`` `` and `$( (echo …) )` print the
    # inner text (XERK-1605).
    if _SUBST_DEPTH[0] >= _MAX_SUBST_DEPTH:
        return _OPAQUE_SUBST
    _SUBST_DEPTH[0] += 1
    try:
        printed, escaped = _body_printed(_subst_inner(m), _reading(), multi, assigns)
    finally:
        _SUBST_DEPTH[0] -= 1
    _SPLICES_ESCAPED[0] += escaped
    if printed is not None:
        if literal and m.group(0)[0] in "$`":
            return _literal(printed)
        # A lone `\` ending the text, spliced plain, escaped what follows it:
        # the `"` closing `sh -c "$(echo "bash -c 'rm …'\\")"` never closed,
        # and the unbalanced line hid the script (XERK-1691). `_PRINTED_DROP`
        # reads it dropped, as `_drop_trailing_escape` does at a script's end
        # (XERK-1646) — an ADDED reading, at the outermost splice only.
        if (len(printed) - len(printed.rstrip("\\"))) % 2:
            _PRINTED_DROP_SEEN[0] = True
            if _PRINTED_DROP[0] and not _SUBST_DEPTH[0]:
                return printed[:-1]
        return printed
    if glued_empty and not _subst_standalone(m):
        return ""
    return _OPAQUE_SUBST


# XERK-1613 — the TAINT reading of a substitution whose output `_body_printed`
# leaves opaque: text its producers emit, carried through any rewriting filter
# as if it passed unchanged. A SEPARATE reading that is ADDED beside the opaque
# one, never swapped in (guard-substitutions.md), and confined to pure
# `;`/pipeline bodies — a conditional, control-flow or backgrounded one is left
# opaque, exactly as main reads it.

# Filters that always re-emit their (transformed) stdin, so a producer's text
# survives them. Unlike `grep -q`, `read` or `wc`, which print nothing or a
# count, these never suppress the line.
_REWRITE_FILTERS = {"sed", "tr", "awk", "gawk", "mawk", "nawk", "cut", "rev",
                    "tac", "nl", "fold", "expand", "unexpand"}

# A grep prints the lines it selects, so it filters like `sed` — unless a flag
# makes it print nothing, a count or file names instead (XERK-1617 QA:
# `$(false || echo rm -rf / | grep .)`).
_GREP_PROGS = {"grep", "egrep", "fgrep"}
# Short and long options that print no line text, and those taking a value
# (the value is skipped, so `-e -q` is a pattern, not quiet).
_GREP_NO_LINES = set("qclL")
_GREP_NO_LINES_LONG = {"--quiet", "--silent", "--count", "--files-with-matches",
                       "--files-without-match"}
_GREP_VALUE_SHORT = set("efmABCdD")
_GREP_VALUE_LONG = {"--regexp", "--file", "--max-count", "--after-context",
                    "--before-context", "--context", "--directories", "--devices",
                    "--label", "--include", "--exclude", "--exclude-dir",
                    "--exclude-from", "--binary-files", "--color", "--colour"}


def _greps_lines(toks: list[str]) -> bool:
    """Whether ``toks`` is a grep that re-emits the lines it reads: no option
    makes it print nothing, a count or file names instead."""
    if _basename(toks[0]) not in _GREP_PROGS:
        return False
    i = 1
    while i < len(toks):
        t = toks[i]
        i += 1
        if t == "--":
            break
        if t.startswith("--"):
            name = t.split("=", 1)[0]
            if name in _GREP_NO_LINES_LONG:
                return False
            if "=" not in t and name in _GREP_VALUE_LONG - {"--color", "--colour"}:
                i += 1
        elif t.startswith("-") and len(t) > 1:
            for k, c in enumerate(t[1:], 1):
                if c in _GREP_NO_LINES:
                    return False
                if c in _GREP_VALUE_SHORT:
                    if k == len(t) - 1:
                        i += 1      # the value is the next word
                    break           # the rest of the cluster is the value
    return True


# Builtins/commands that print nothing to stdout, so an unknown such statement
# owes no unread-output mark (`$(cd x; echo …)` runs no unknown program).
_SILENT_PROGS = {"true", "false", ":", "cd", "pushd", "popd", "export", "unset",
                 "set", "shopt", "umask", "local", "declare", "readonly",
                 "typeset", "trap", "wait", "read", "hash", "ulimit", "alias",
                 "unalias", "test", "["}

# Shell control-flow words: a body using them runs statements conditionally, so
# which output prints is unknown — the taint reading gives up and stays opaque.
_CONTROL_WORDS = {"if", "then", "elif", "else", "fi", "for", "while", "until",
                  "do", "done", "case", "esac", "in", "select", "{", "}", "function"}

# A bare stdout redirect sends a statement's output to a file or another fd, so
# it prints NOTHING the substitution sees (`echo x >/dev/null; echo P` is P).
# `2>&1` keeps `2` before the `>` so the lookbehind skips it.
_STDOUT_REDIR_RE = re.compile(r"(?<![0-9&>|])(?:&>>?|1?>>?|>&)")

# Stands in for the output of a statement the taint reading cannot read but
# that still runs and prints something unknown. As the PROGRAM word of a
# command (`$(basename /x/rm; echo -rf /etc)`) it is refused (`_UNREAD_PROG`);
# it carries `_OPAQUE_SUBST`, so a path check reads it as the placeholder.
_UNREAD_OUTPUT = _OPAQUE_SUBST + "_unread"

_ASSIGN_VALUE_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]*\])?\+?=\S*\Z")


def _subst_is_assign_value(m: "re.Match[str]") -> bool:
    """Whether the substitution is the VALUE of a `NAME=`/`NAME+=` assignment,
    whose output bash STORES rather than runs (so its taint must not splice in
    as a runnable word — a later `$NAME` is read on its own)."""
    s, a = m.string, m.start()
    j = a
    while j > 0 and s[j - 1] not in " \t\n;|&()<>\"'`":
        j -= 1
    return bool(_ASSIGN_VALUE_RE.match(s[j:a]))


def _arith_interior(body: str) -> str | None:
    """The expression of a `$((…))` whose `$(` group body is ``body`` — `(` at
    its start closing at its end — else None (`$((a) (b))` is a subshell)."""
    if not (body.startswith("(") and body.endswith(")")):
        return None
    depth = 0
    for i, ch in enumerate(body):
        depth += {"(": 1, ")": -1}.get(ch, 0)
        if depth == 0:
            return body[1:-1] if i == len(body) - 1 else None
    return None


# What may sit between a `$((` and a substitution inside it, and between the
# substitution and the `))`, for `_subst_in_arith` to call it arithmetic:
# operands and operators only. A quote, `#`, backslash, `;`, `|`, `&` or
# newline means the `$((` may be a decoy (`echo '$((' ; $(…) ; echo '))'`).
_ARITH_GAP_RE = re.compile(r"[\w \t$+\-*/%<>=!~^?:,(){}\[\].]*\Z")


def _subst_in_arith(m: "re.Match[str]") -> bool:
    """Whether the substitution sits inside a `$((…))` of the text it was
    found in, where its output is an arithmetic OPERAND, never a program. The
    line pass reads a `$((…))` assignment value or env prefix in place:
    `N=$(( $(nproc || echo 2) * 2 ))` was refused as an unread program (XERK-1617
    QA). Neither this nor `_find_substs` tracks quoting, so the text around the
    substitution up to the `$((` and the `))` must be plain arithmetic
    (`_ARITH_GAP_RE`); anything else reads as not arithmetic, the deny side."""
    s, a, b = m.string, m.start(), m.end()
    p = s.rfind("$((", 0, a)
    if p < 0 or (p and s[p - 1] == "\\"):
        return False
    depth = 2
    for ch in s[p + 3:a]:
        depth += {"(": 1, ")": -1}.get(ch, 0)
        if depth < 2:
            return False    # that `$((` closed before the substitution
    j = b
    while j < len(s) and depth:
        depth += {"(": 1, ")": -1}.get(s[j], 0)
        j += 1
        if depth == 1 and s[j:j + 1] != ")":
            return False    # `((` closed apart: `$( (…) (…) )`, a subshell
    return (depth == 0 and bool(_ARITH_GAP_RE.match(s[p + 3:a]))
            and bool(_ARITH_GAP_RE.match(s[b:j])))


def _has_conditional(body: str) -> bool:
    """Whether ``body`` joins statements with `&&` or `||`, so any of them may
    be skipped and a LATER one's output may come first."""
    q = _quote_states(body)
    return any(q[i] == "" and body[i:i + 2] in ("&&", "||") for i in range(len(body)))


def _has_background(body: str) -> bool:
    """Whether ``body`` backgrounds a statement with `&`, so the order its
    output interleaves with the others' is unknown."""
    q = _quote_states(body)
    for i in range(len(body)):
        if q[i] == "" and body[i] == "&" and body[i:i + 2] not in ("&&", "&>") \
                and (i == 0 or body[i - 1] not in "&>|"):
            return True
    return False


def _stdout_redirected(stmt: str) -> bool:
    """Whether ``stmt`` sends its stdout off the substitution — a file,
    `/dev/null` or another fd (`>&2`); a here-string `<<<` is input, not this."""
    masked = "".join(" " if st in ("'", '"', "#") else ch
                     for ch, st in zip(stmt, _quote_states(stmt)))
    return bool(_STDOUT_REDIR_RE.search(masked))


def _stmt_tainted(stmt: str) -> tuple[str, bool] | None:
    """What one statement's PRODUCER emits as taint — echo/printf arguments, or
    a here-string — carried through any pass-through or rewriting filter, plus
    whether it ends a line. None where the output is unknown or thrown away: a
    stage that is neither pass-through nor a rewriting filter (`grep -q`, a bare
    command), or a stdout redirect."""
    if _stdout_redirected(stmt):
        return None
    stages = _split_segments(stmt)
    if not stages:
        return None
    for st in stages[1:]:
        toks = _strip_prefixes(_tokenize(_unwrap_group(st)))
        if not toks or not (_passes_input(st) or _basename(toks[0]) in _REWRITE_FILTERS
                            or _greps_lines(toks)):
            return None
    first = _strip_prefixes(_tokenize(_unwrap_group(stages[0])))
    text = _printed_from_tokens(first)
    if text is not None:
        if first and _basename(first[0]) == "printf":
            return text, text.endswith("\n")
        return text, not any(re.match(r"^-[neE]*n", t) for t in first[1:3])
    # A here-string PRODUCER, but only where the command it feeds re-emits it:
    # `cat`/`tr`/`sed <<< X` print X, `grep -q`/`read <<< X` print nothing.
    for st in stages:
        ust = _unwrap_group(st)
        hs = _herestrings(ust)
        if hs:
            toks = _strip_prefixes(_tokenize(ust))
            if toks and _basename(toks[0]) in (_PASS_THROUGH | _REWRITE_FILTERS):
                return hs[0], True   # `<<<` appends a trailing newline
            return None
    return None


# A conditional body holding more statements than this is read as if its
# output could start with an unread one, rather than as every suffix: each
# suffix is a re-expansion of the whole segment.
_MAX_TAINT_STARTS = 8

# Which of a conditional body's suffix readings `_taint_subst` and
# `_taint_line_repl` splice in (`_TAINT_START`), and whether any substitution
# they read had a reading past it (`_TAINT_MORE`), so the caller knows to ask
# for the next one.
_TAINT_START = [0]
_TAINT_MORE = [False]


def _taint_nested(m: "re.Match[str]") -> str:
    """What one of a taint body's OWN substitutions prints, for reading the
    body after them: its taint, else `_UNREAD_OUTPUT` (it runs and prints
    something). `$(echo $(cat <<< 'rm …'))` had its echo argument tokenised
    with the inner `$(…)` still in it, which dropped its `)` and quotes, so the
    inner producer was never read (XERK-1617). A `<(…)` is a path and an
    assignment value is stored, so both stay the opaque placeholder."""
    if m.group(0)[0] not in "$`" or _subst_is_assign_value(m):
        return _OPAQUE_SUBST
    if _SUBST_DEPTH[0] >= _MAX_SUBST_DEPTH:
        return _UNREAD_OUTPUT
    _SUBST_DEPTH[0] += 1
    try:
        taint = _body_tainted(_subst_inner(m))
    finally:
        _SUBST_DEPTH[0] -= 1
    # The every-statement-ran reading; a nested conditional's skipped ones are
    # a residual (guard-substitutions.md).
    return taint[0] if taint is not None else _UNREAD_OUTPUT


def _body_tainted(body: str) -> tuple[str, ...] | None:
    """The taint readings of a substitution body, or None to leave it opaque.
    Its own substitutions resolve the way the enclosing parse does (escaped
    ones kept literal unless `_SPLICE_RAW`), so the memo is keyed on that."""
    return _body_tainted_at(body, _reading())


@functools.lru_cache(maxsize=512)
def _body_tainted_at(body: str, raw: tuple) -> tuple[str, ...] | None:
    """`_body_tainted` for one `_reading()`.

    A rewriting filter, a non-echo producer, or an unread statement left the
    body opaque while bash ran its output (XERK-1613):
    `$(echo rm -rf / | sed '')`, `$(true; cat <<< 'rm -rf /')`,
    `$(basename /x/rm; echo -rf /etc)`. Each statement contributes its
    producer's text (a filter assumed identity — modelling each is partial, and
    failing closed denies `$(command -v tool) args`); a statement that still
    prints something UNKNOWN contributes `_UNREAD_OUTPUT`, so its output naming
    the program is refused. None for a LONE unknown statement (that IS
    `$(command -v tool)`), and for a control-flow or backgrounded body whose
    printing order is unknown (left opaque, as on main). A rewrite that makes
    harmless text dangerous (`echo /etc/x | sed s,/x,,`) still slips.

    The body's own substitutions are resolved first (`_taint_nested`), as
    `_body_printed` does. A `&&`/`||` body may skip any statement, so whichever
    runs first takes the program slot: `$(ls -d /usr/bin/rm /x || echo -rf
    /etc)` prints `/usr/bin/rm -rf /etc` when ls fails having printed. Its
    readings are every SUFFIX of its statements (XERK-1617), each spliced in
    on its own so the words after the substitution follow every one; a
    statement skipped mid-way only drops words, never the program.
    """
    before = _SPLICES_ESCAPED[0]
    try:
        body = _sub_substs(body, _taint_nested)
    finally:
        # A separate reading: its escaped skips must not ask the caller for
        # an every-expansion-live pass the plain reading did not.
        _SPLICES_ESCAPED[0] = before
    if _has_background(body):
        return None
    out: list[str] = []
    producers = False
    for stmt in _split_on_operators(body, include_pipe=False):
        stmt = _unwrap_group(stmt).lstrip("( \t").rstrip(") \t")
        toks = _strip_prefixes(_tokenize(stmt))
        if not toks:
            continue
        if _basename(toks[0]) in _CONTROL_WORDS:
            return None
        known = _stmt_tainted(stmt)
        if known is not None:
            producers = True
            out.append(known[0])
        elif _stdout_redirected(stmt) or _basename(toks[0]) in _SILENT_PROGS:
            continue
        else:
            out.append(_UNREAD_OUTPUT)
    if not producers:
        return None
    # Joined with SPACE, never newline: a command substitution's output is
    # word-split on IFS, so `$(basename /x/rm; echo -rf /etc)` is the ONE
    # command `rm -rf /etc`, and a newline here would forge a command boundary
    # that turned a later arg into a phantom program (XERK-1613 QA). An unread
    # statement after a producer is thus a trailing WORD, not the program —
    # only a leading one takes the program slot (`_UNREAD_PROG`).
    out = [x for x in out if x]
    if not out:
        # Every producer printed nothing, so the output is empty: `$(echo '' |
        # sed 1q) rm …` runs `rm` (XERK-1717 QA). Opaque, the placeholder hid it.
        return ("",)
    if not _has_conditional(body) or len(out) == 1:
        return (" ".join(out),)
    if len(out) > _MAX_TAINT_STARTS:
        # Too many to read each: any of them may lead, unread or not.
        return (" ".join(out), _UNREAD_OUTPUT + " " + " ".join(out))
    return tuple(" ".join(out[i:]) for i in range(len(out)))


def _taint_pick(readings: tuple[str, ...]) -> str:
    """The reading `_TAINT_START` asks for, noting whether one lies past it."""
    k = _TAINT_START[0]
    if len(readings) > k + 1:
        _TAINT_MORE[0] = True
    return readings[min(k, len(readings) - 1)]


def _taint_readings(text: str, repl) -> list[str]:
    """``text`` with its substitutions replaced by ``repl`` (`_taint_subst` or
    `_taint_line_repl`) once per suffix reading a conditional body has; one
    sweep for a line holding none."""
    out: list[str] = []
    saved = _TAINT_START[0], _TAINT_MORE[0]
    try:
        for k in range(_MAX_TAINT_STARTS):
            _TAINT_START[0], _TAINT_MORE[0] = k, False
            out.append(_sub_substs(text, repl))
            if not _TAINT_MORE[0]:
                break
    finally:
        _TAINT_START[0], _TAINT_MORE[0] = saved
    return out


def _taint_in_command_pos(seg: str) -> bool:
    """Whether a taint segment's `_UNREAD_OUTPUT` sits in PROGRAM position, not
    in a `for … in`/`select` word list or an array — where the substitution's
    output is DATA, so `$(ls; echo y)` as a list element must not be refused
    (XERK-1613 QA). `_strip_prefixes` peels `for f in`, exposing the first word,
    so the raw tokens before the marker are what tell the two apart."""
    raw = _tokenize(seg)
    pos = next((k for k, t in enumerate(raw) if _UNREAD_OUTPUT in t), -1)
    before = raw[:pos]
    return not (any(_basename(t) in _WORDLIST_HEADS for t in before)
                or any("=(" in t for t in before))


def _taint_subst(m: "re.Match[str]") -> str:
    """`_subst_text`'s taint sibling for a segment-level pass: a substitution's
    taint reading where one exists, else the opaque placeholder. An assignment
    VALUE stays opaque (its output is stored, not run)."""
    if m.group(0)[0] not in "$`" or _subst_is_assign_value(m) or _subst_in_arith(m):
        return _OPAQUE_SUBST
    taint = _body_tainted(_subst_inner(m))
    return _taint_pick(taint) if taint is not None else _OPAQUE_SUBST


def _taint_line_repl(m: "re.Match[str]") -> str:
    """Line-level taint: segmenting cuts `$(true; cat <<< …)` in half before
    `_taint_subst` can read it, so the whole line is rebuilt once with each
    OPERATOR-holding substitution replaced by its taint. A non-cut one is left
    for the segment pass; an assignment value and an opaque body are left
    untouched, so only a real taint changes the line."""
    body = _subst_inner(m)
    if (not _SEGMENT_SPLIT.search(body) or m.group(0)[0] not in "$`"
            or _subst_is_assign_value(m) or _subst_in_arith(m)):
        return m.group(0)
    taint = _body_tainted(body)
    if taint is None:
        return m.group(0)
    taint = _taint_pick(taint)
    if "$(" not in taint and "`" not in taint:  # an empty print too (XERK-1717 QA)
        return taint
    return m.group(0)


def _sub_substs(text: str, repl) -> str:
    """Every substitution `_find_substs` sees in ``text`` replaced by
    ``repl(m)``, reading an ESCAPED substitution (`\\$(…)`, `` \\`…\\` ``) as
    the parse it sits in does: literal text.

    Substituting it left its backslash to escape whatever came next, so
    `"\\"\\$(true)\\""` closed the string early and the rest of it was read
    as commands (XERK-1543). The escape holds for ONE parse — `bash -c "rm -rf
    \\$(echo /etc)"` runs it at the next — so a skip also asks `_expand_both`
    for its every-expansion-live reading, which reads the text as that next
    parse would: every escaped substitution live, its escapes dropped with it.
    Its body is classified as if it ran either way, by the caller's own pass
    over every match.
    """
    raw = _SPLICE_RAW[0]
    out: list[str] = []
    last = 0
    for m in _find_substs(text):
        k = m.start()
        while k > 0 and text[k - 1] == "\\":
            k -= 1
        if not raw and (m.start() - k) % 2:
            _SPLICES_ESCAPED[0] += 1
            continue
        if raw:
            k = max(k, last)
        out.append(text[last:k if raw else m.start()])
        out.append(repl(m))
        last = m.end()
    out.append(text[last:])
    return "".join(out)


class _Subst:
    """A substitution `_find_substs` found, shaped like the `re.Match` of
    `_SUBST_RE` its callers were written against."""

    def __init__(self, string: str, start: int, end: int, body: str) -> None:
        self.string, self._start, self._end, self._body = string, start, end, body

    def start(self) -> int:
        return self._start

    def end(self) -> int:
        return self._end

    def group(self, i: int = 0) -> str:
        return self.string[self._start:self._end] if i == 0 else self._body

    def groups(self) -> tuple[str]:
        return (self._body,)


# One escape level of a backtick body, as bash removes it before running it.
_BACKTICK_UNESCAPE_RE = re.compile(r"\\([\\`$])")


def _find_substs(text: str) -> list[_Subst]:
    r"""The outermost `$(…)`, `<(…)`, `>(…)` and backtick substitutions in
    ``text``, escaped or not, each with the body bash would run.

    `_SUBST_RE` cannot nest, so `\\$( (echo rm -rf /etc) )` matched nothing
    and `` \\`echo \\\\\\`echo …\\\\\\`\\` `` paired the wrong backticks —
    each ran a printed command unclassified at the next parse (XERK-1605).
    - Parens pair by depth (an escaped one is text). `$((…))` whose inner
      `(` closes at the end is arithmetic, which bash never runs — but the
      substitutions inside it do, so the scan goes on into it.
    - A backtick closes the open one with the SAME backslash run before it,
      else opens another: nesting is written by escaping deeper, at any
      re-parse depth (`` `a \\`b\\`` `` and `` \\`a \\\\\\`b\\\\\\`\\` ``). Its body has
      one escape level removed, as bash does. One with no partner pairs with
      the next backtick, as `_SUBST_RE` did.
    Both pairings are one stack pass over the whole text, so unclosed
    openers stay linear: a scan per opener is O(n²), past the hook timeout.
    - A `)` closes only a `(` quoted the same way (`_quote_states`): read
      blind, the `)` in `$(echo ")'")` ended the body there and its `'` hid
      the rest of the line (XERK-1621). An escaped `\\$(` inside `"…"` is
      string text throughout, so it still pairs as it did.
    """
    n = len(text)
    close_paren: dict[int, int] = {}
    parens: list[int] = []
    # With no quote or comment in the text every paren is bare: skip the scan.
    states = _quote_states(text) if "(" in text and not _MAIN_PARSE[0] and (
        "'" in text or '"' in text or "#" in text) else []
    ticks: list[tuple[int, int]] = []     # (index, backslashes before it)
    i = 0
    while i < n:
        ch = text[i]
        if ch == "\\":
            j = i
            while j < n and text[j] == "\\":
                j += 1
            if j < n and text[j] == "`":
                ticks.append((j, j - i))
                i = j + 1
            else:
                # An odd run escapes text[j]; an even one leaves it live.
                i = j + 1 if (j - i) % 2 else j
            continue
        if ch == "`":
            ticks.append((i, 0))
        elif ch == "(":
            parens.append(i)
        elif ch == ")" and parens and (not states or states[parens[-1]] == states[i]):
            close_paren[parens.pop()] = i
        elif ch == ")" and parens:
            _MAIN_PARSE_SEEN[0] = True
        i += 1
    close_tick: dict[int, int] = {}
    stack: list[tuple[int, int]] = []
    open_runs: dict[int, int] = {}
    for idx, run in ticks:
        if open_runs.get(run):
            while True:
                o, r = stack.pop()
                open_runs[r] -= 1
                if r == run:
                    close_tick[o] = idx
                    break
        else:
            stack.append((idx, run))
            open_runs[run] = open_runs.get(run, 0) + 1
    tick_at = {idx: run for idx, run in ticks}
    next_tick = {a: b for (a, _), (b, _) in zip(ticks, ticks[1:])}

    out: list[_Subst] = []
    i = 0
    while i < n:
        ch = text[i]
        if ch in "$<>" and text.startswith("(", i + 1):
            end = close_paren.get(i + 1)
            if end is None:
                i += 2
                continue
            body = text[i + 2:end]
            inner = close_paren.get(i + 2) if body.startswith("(") else None
            if ch == "$" and inner == end - 1:
                i += 3  # arithmetic: only the substitutions inside it run
                continue
            out.append(_Subst(text, i, end + 1, body))
            i = end + 1
            continue
        if ch == "`" and i in tick_at:
            end = close_tick.get(i)
            if end is None or end < i:
                end = next_tick.get(i)
            if end is None:
                i += 1
                continue
            stop = end - tick_at[end]
            out.append(_Subst(text, i, end + 1, _BACKTICK_UNESCAPE_RE.sub(
                r"\1", text[i + 1:max(stop, i + 1)])))
            i = end + 1
            continue
        i += 1
    return out


# How deep the expansion recurses before giving up. Exhausting it DENIES
# (`_TOO_DEEP`): a group body is only reachable by recursing, so returning
# nothing let `(true; (true; … rm -rf /))` seven deep through (XERK-1083).
# Real commands reach depth 0-2.
_MAX_EXPAND_DEPTH = 6

# The body `_balanced_groups` returns for `$((n+1))` / `((i++))`: a wordless
# `(…)` bash can only evaluate as arithmetic, never run. Recursing into it cost
# two depth levels for nothing and pushed a real nested `ssh … sh -c` command
# past the budget. Whitespace, `$` or a backtick disqualifies it — bash DOES
# run `$((echo hi) )` as a command substitution.
_ARITH_BODY_RE = re.compile(r"\([^\s$`]*\)\Z")

# The program name `_expand_segments` reports once the depth budget is spent.
_TOO_DEEP = "\x00turma-too-deep"

# ...and the one it reports for a program named by a substitution's unread
# output, handed the arguments a statement beside it printed (see
# `_body_tainted`): `$(basename /x/rm; echo -rf /etc)`.
_UNREAD_PROG = "\x00turma-unread-program"

# How many characters inlining variables may ADD across one decision (an exec
# wrapper's suffix pass charges the words it emits here too).
# Each `$x` use inlines x's whole value and the result is split and classified
# again, so a large value used many times cost minutes — past Claude Code's
# hook timeout, which RUNS the command unchecked (XERK-1556). Exhausting it
# DENIES (`_TOO_LARGE`), never stops early: the unread tail is where an `rm`
# would hide. Spent incrementally, so the oversized text is never built.
# One expansion still re-substitutes the same text 2-6x (cwd tracking, groups,
# `$(…)`), so this allows roughly 170-500 KiB of inlined text; real commands
# spend at most ~10 KiB.
_MAX_SUBST_GROWTH = 1024 * 1024

# How long one decision may spend expanding before it DENIES as too large. The
# growth budget counts characters, not time, and a long line re-expanded once
# per reading at every eval / `-c` level ran toward Claude Code's hook
# timeout, which RUNS the command unchecked (XERK-1615 QA). Real commands
# take well under a second.
_MAX_DECIDE_SECONDS = 30

# The program name `_expand_segments` reports once the growth budget is spent.
_TOO_LARGE = "\x00turma-too-large"
_TOO_LARGE_REASON = ("refusing a command too large to classify (its variables or wrapped "
                     "arguments expand too far) — split it, or put the data in a file")


class _ExpansionTooLarge(Exception):
    pass


# The decision under way: characters still to spend, and the expansions already
# made. ONE per decision, opened by whichever budgeted entry point is reached
# first: a fresh budget per `_expand_segments` call let a line re-expanded once
# per heredoc spend it N times over. Every check re-expands the same command, so
# a whole expansion is memoised and charged once; a substitution never is —
# identical bodies at N places are N times the work.
_budget: dict | None = None


def _budgeted(fn):
    """Run ``fn`` under the decision's budget, opening one if none is open."""

    @functools.wraps(fn)
    def run(*args, **kwargs):
        global _budget
        if _budget is not None:
            return fn(*args, **kwargs)
        _budget = {"left": _MAX_SUBST_GROWTH, "expand": {}, "vals": {}, "capped": False, "proc": {},
                   "posread": {}, "until": time.monotonic() + _MAX_DECIDE_SECONDS}
        # Lives as long as the memo that may skip re-reading the values.
        _VALUES_DIFFER[0] = False
        _CHAIN_DIFFERS[0] = False
        _ORDER_DIFFERS[0] = False
        _VALUES_TAINT_N[0] = 0
        _VALUES_MOST[0] = 1
        _VALUES_ASSIGNED[0] = 1
        _VALUE_COUNTS.clear()
        _BRACE_OTHER_SEEN[0] = False
        _MAIN_PARSE_SEEN[0] = False
        _BRACE_QUOTED_SEEN[0] = False
        _READINGS_SEEN[0] = False
        _PRINTED_DROP_SEEN[0] = False
        _READINGS_MOST[0] = 0
        _PWD_SEEN[0] = False
        _FOR_NAMES.clear()
        # These memos set the readings' SEEN flags as they fill, and a hit
        # skips that: a body cached by an earlier decision in this process
        # never asked for this one's extra readings.
        _closers.cache_clear()
        _body_printed.cache_clear()
        _body_tainted_at.cache_clear()
        _unsplit_cuts_at.cache_clear()
        try:
            return fn(*args, **kwargs)
        finally:
            _budget = None

    return run


def _memo(kind: str, key, fn, *args):
    """``fn(*args)``, made once per decision. A hit replays the escaping
    splices it counted, which is what makes `_expand_both` take its raw pass."""
    memo = _budget[kind]
    key = (key, _SPLICE_RAW[0], _VALUES_MULTI[0], _VALUES_TAINT[0], _BRACE_GLUED[0],
           _VALUE_PICK[0], _BRACE_OTHER_SHELL[0], _MAIN_PARSE[0], _VALUES_CHAINED[0],
           _FOR_PICK[0], _HOME_KEPT[0], _READINGS_JOINED[0], _BRACE_QUOTED[0], _PRINTED_DROP[0],
           _READING_PICK[0], _PWD_UNASSIGNED[0])
    if key not in memo:
        before = _SPLICES_ESCAPED[0]
        memo[key] = (fn(*args), _SPLICES_ESCAPED[0] - before)
    else:
        _SPLICES_ESCAPED[0] += memo[key][1]
    return memo[key][0]


def _spend(added: int) -> None:
    """Charge ``added`` inlined characters; raise once the budget is spent."""
    if added <= 0 or _budget is None:
        return
    _budget["left"] -= added
    if _budget["left"] < 0:
        raise _ExpansionTooLarge


# --- pre-normalisation ---------------------------------------------------
#
# The shell rewrites a command line before it runs it, and every one of these
# rewrites was a way to spell a destructive command that the classifier read as
# something else. They are undone here, once, so the rest of the file only ever
# sees the plain form: `rm${IFS}-rf${IFS}/etc`, `rm -rf {/etc,/var}`,
# `rm -rf $'\x2fetc'` and `for d in /etc; do rm -rf $d; done` all normalise to
# `rm -rf /etc`.

_IFS_RE = re.compile(r"\$\{IFS\}|\$IFS")
# With the backslash run before it: after an ODD run (`"\$'…'"`) the `$` is
# literal to this parse and the string ANSI-C only to a shell that re-parses it
# (`bash -c`), so decoding it here ate the `$` that re-parse needs. After an
# EVEN run (`\\$'…'`) it is still a live ANSI-C string (XERK-1611).
_ANSI_C_RE = re.compile(r"(?<!\\)(\\*)\$'((?:[^'\\]|\\.)*)'")
# A `{…}` word; it expands when it holds a `,` (`{,bash}` too: bash drops the
# empty word) or is a sequence. Testing that in the regex (`[^{}\s]+,[^{}\s]*`)
# backtracked over every comma of an unclosed `{a,a,…`: quadratic, and a hook
# that times out runs the command (XERK-1596).
_BRACE_RE = re.compile(r"\{([^{}\s]+)\}")
# `{h..h}`, `{1..3}`, `{a..e..2}`: a sequence bash expands like a list (XERK-1629).
_BRACE_SEQ_RE = re.compile(r"(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?")
# The most words a sequence is expanded to; a longer one is left as written.
_BRACE_SEQ_MAX = 64
_BRACE_WORD_END = frozenset(" \t\n;&|<>()")
_BRACE_WORD_END_RE = re.compile(r"[ \t\n;&|<>()]")
# A quoted value is read WHOLE: cut at its first blank, `x='rm -rf /'; eval $x`
# inlined as `eval 'rm` (XERK-1256).
# A value is read WHOLE, quoted runs and substitutions included: cut at its
# first blank, `x='rm -rf /'; eval $x` inlined as `eval 'rm` (XERK-1256), and
# `x=$(echo 'rm -rf /'); $x` as `$(echo` (XERK-1549). Any word starting a
# blank-separated `NAME=`/`NAME+=` counts: `declare a=1 x=…`, `local -- x=…`,
# and an env prefix all assign, and reading one too many only resolves more.
_ASSIGN_NEST = r"[^()]*"
for _ in range(8):  # parentheses nested this deep inside one `$(…)`
    _ASSIGN_NEST = r"(?:[^()]|\(" + _ASSIGN_NEST + r"\))*"
# A backtick body ends at the first UNESCAPED backtick: `[^`]*` cut
# x=`echo \`echo …\`` at the inner opener and kept only `echo` (XERK-1605).
_ASSIGN_SUBST = r"\$\(" + _ASSIGN_NEST + r"\)|`(?:[^`\\]|\\.)*`"
_ASSIGN_SUBST_RE = re.compile(_ASSIGN_SUBST)
_ASSIGN_WORD = r"(?:" + _ASSIGN_SUBST + r"|'[^']*'|\"(?:[^\"\\]|\\.)*\"|[^\s;|&\n'\"`])*"
_VAR_ASSIGN_RE = re.compile(
    # A lookbehind, not a consumed lead-in plus `\s*`: that re-scanned a
    # whitespace run from each of its blanks, quadratic in its length (XERK-1601).
    r"(?<![^;\n&|\s])"
    r"([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]\s]*\])?\+?="
    r"(\([^()]*\)|" + _ASSIGN_WORD + r")"
)
_ASSIGN_WORD_RE = re.compile(_ASSIGN_WORD)


def _for_lists(command: str) -> list[tuple[str, int, int, list[str], bool]]:
    """`_for_lists_of`, cached per text AND the parse flags `_quote_states`
    reads: keyed on the text alone, a flagged reading got the plain one's."""
    return _for_lists_of(command, (_BRACE_OTHER_SHELL[0], _MAIN_PARSE[0]))


@functools.lru_cache(maxsize=32)
def _for_lists_of(command: str, _flags: tuple) -> list[tuple[str, int, int, list[str], bool]]:
    """Each `for NAME in LIST`: its name, the list's span, its raw words, and
    whether a `do` (or bash's `{`) follows it as a shell loop's must. The list
    is read word by word, quotes and `$(…)` whole, so a quoted `;` is part of
    a word: cut at it, `for v in a 'x;y' 'rm …'` bound only `a` (XERK-1647).
    Python's `for f in a if …` in a quoted script has no `do`, and is read
    as before, to the `;` or newline: scanned whole, its words ran on into
    the quotes around it and nested too deeply (QA). Cached: every reading
    of the line asks again, and callers only read the result."""
    found = []
    states = _quote_states(command) if "${" in command else []
    # A `for` inside a shell list already read is one of its words, as bash
    # reads it. One inside another language's `for … in` text is still read:
    # it may be the line's real loop (`echo for x in y && for v in …`, QA).
    # Where a text scan ended is cached per word start it passed (`_for_scan`),
    # so a run of `for … in` with no `do` is scanned once, not once per `for`.
    shell_after, text_after, scanned = 0, 0, {}
    for m in _FOR_IN_RE.finditer(command):
        if m.start() < shell_after:
            continue
        end, words, visited, known = _for_scan(command, m.end(), states, scanned)
        if known is not None:
            # Ran into an earlier text scan: the rest is that scan's.
            end, shell = known
            words = []
        else:
            shell = bool(_FOR_DO_RE.match(command, end))
        if not shell:
            # A shell list's own `for` words are skipped above, so only
            # these are ever reached again.
            for p in visited:
                scanned[p] = (end, shell)
        if shell:
            shell_after = end
            # A brace word is a word per item, as bash expands it before the
            # loop binds: `for v in a {'rm …',b}` runs `rm …` (XERK-1657).
            words = [w for word in words for w in _brace_words(word) if w]
        elif m.start() < text_after:
            # Bound as before XERK-1647, by one regex pass: a `for` inside an
            # earlier match's text binds nothing. Rebound each, it was O(n²).
            end, words = text_after, []
        else:
            end = m.end() + len(re.match(r"[^;\n]*", command[m.end():]).group(0))
            words = [w.group(0) for w in _ASSIGN_WORD_RE.finditer(command, m.end(), end)
                     if w.group(0) and w.group(0) != "do"]
            text_after = end
        found.append((m.group(1), m.end(), end, words, shell))
    return found


def _for_scan(command: str, pos: int, states: list[str], scanned: dict
              ) -> tuple[int, list[str], list[int], tuple[int, bool] | None]:
    """A shell `for` list from ``pos``: where it ends, its words, and the word
    starts it passed — or, once it reaches a word start an earlier scan of
    ``scanned`` passed, that scan's end and verdict (a scan from a position
    goes on the same whatever reached it, and stopping there keeps a line of
    `for … in` linear, even one inside `${…}` that is no word start, QA). A
    `${…}` holding `;` or a newline is read through, as an assignment's value
    is (`_assign_value_end`): `for v in a ${x:-;} 'rm …'` cut there."""
    end, words, visited = pos, [], []
    while pos < len(command):
        if pos in scanned:
            return end, words, visited, scanned[pos]
        visited.append(pos)
        # `do` in the list is a word like any (`for v in a do 'rm …'`).
        w = _FOR_WORD_RE.match(command, pos)
        if not w.group(0):
            break
        stop = w.end()
        if "${" in w.group(0):
            stop = _assign_value_end(command, states, pos, stop)
            while stop < len(command) and command[stop] not in " \t\n;|&":
                more = _FOR_WORD_RE.match(command, stop).end()
                if more == stop:
                    break
                stop = _assign_value_end(command, states, stop, more)
        words.append(command[pos:stop])
        pos = end = stop
        while pos < len(command) and command[pos] in " \t":
            pos += 1
    return end, words, visited, None


def _brace_words(word: str) -> list[str]:
    """A raw ``word`` as bash brace-expands it: a word per item of each
    unquoted `{a,b}` / `{x..y}`, its items' quotes kept for `_dequote_value`.
    `_expand_braces` reads no list holding a blank, which a quoted item may
    (`{'rm -rf /etc',b}`). Past `_BRACE_SEQ_MAX` words each item of each list
    is added as a word of its own (`_brace_items_flat`)."""
    if "{" not in word:
        return [word]
    out, todo = [], [word]
    while todo:
        w = todo.pop()
        span = _brace_list(w)
        if span is not None and len(out) + len(todo) >= _BRACE_SEQ_MAX:
            # Past the cap every item is read as a word of its own: kept as
            # written, a later item ran unread (XERK-1657 QA); refused as too
            # large, a long brace in heredoc text nothing runs was denied.
            return [*out, *todo, *_brace_items_flat(word)]
        if span is None:
            out.append(w)
            continue
        start, end, items = span
        todo.extend(w[:start] + item + w[end:] for item in reversed(items))
    return out


# How deep `_brace_items_flat` opens nested lists: each level rescans its item,
# so cost is depth × length; at 4, a payload 5 deep went unread (QA).
_BRACE_FLAT_DEPTH = 64


def _brace_items_flat(word: str, depth: int = 0) -> list[str]:
    """Every item of every brace list in ``word``, each a word, nested lists
    flattened: the cap's reading."""
    if depth >= _BRACE_FLAT_DEPTH:
        return [word]  # deeper still: the item as written, never dropped (QA)
    out, pos = [], 0
    while True:
        span = _brace_list(word[pos:])
        if span is None:
            break
        start, end, items = span
        for item in items:
            out.extend(_brace_items_flat(item, depth + 1) if "{" in item else [item])
        pos += end
    return out


def _brace_list(word: str) -> tuple[int, int, list[str]] | None:
    """The first unquoted brace list in ``word``: its span and items."""
    i, n, quote = 0, len(word), ""
    while i < n:
        ch = word[i]
        if quote:
            if ch == quote:
                quote = ""
            elif ch == "\\" and quote == '"':
                i += 1
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "{" and not (i and word[i - 1] == "$"):
            got = _brace_items(word, i)
            if got is not None:
                return i, got[0], got[1]
        i += 1
    return None


def _brace_items(word: str, start: int) -> tuple[int, list[str]] | None:
    """Where the `{` at ``start`` closes (past its `}`) and its items, when it
    is a list (an unquoted `,` at its own depth) or a sequence."""
    i, n, quote, depth, cut, items = start + 1, len(word), "", 0, start + 1, []
    while i < n:
        ch = word[i]
        if quote:
            if ch == quote:
                quote = ""
            elif ch == "\\" and quote == '"':
                i += 1
        elif ch == "\\":
            i += 1
        elif ch in "'\"":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
        elif ch == "," and not depth:
            items.append(word[cut:i])
            cut = i + 1
        elif ch == "}":
            if items:
                return i + 1, [*items, word[cut:i]]
            seq = _brace_sequence(word[start + 1:i])
            return (i + 1, seq) if seq else None
        i += 1
    return None


# A `for` list word: an assignment's, plus `$'…'` with its `\'` and a
# backslash-escaped character (`x\;y` is one word). Read as an assignment's,
# `for v in $'it\'s' 'x;y' 'rm …'` paired the quotes wrong and cut the list.
_FOR_WORD_RE = re.compile(r"(?:\$'(?:[^'\\]|\\.)*'|" + _ASSIGN_SUBST
                          + r"|'[^']*'|\"(?:[^\"\\]|\\.)*\"|\\.|[^\s;|&\n'\"`\\])*", re.S)
# What may sit between a shell `for` list and its `do` (or `{`): blanks,
# `;`, newlines, comments.
_FOR_DO_RE = re.compile(r"(?:[ \t;\n]|#[^\n]*)*(?:\bdo\b|\{)")


def _assign_value_end(command: str, states: list[str], start: int, end: int) -> int:
    """Where an assignment's value really ends: past any `${…}` in it that
    closes beyond the regex's match. The regex pairs `"` flat, so it cut
    `x="${y:-"rm -rf /"}"` at the inner quote (XERK-1621). After the `}`,
    the rest of the string it sits in (``states``, `_quote_states`) is the
    value's too, then any word text glued on."""
    i = command.find("${", start, end)
    while 0 <= i < end:
        close = _brace_end(command, i, states[i] == '"') if _live_dollar(command, i) else -1
        if close >= end:
            j = close + 1
            while j < len(command) and states[j] in ('"', "'", "\\"):
                j += 1
            end = _ASSIGN_WORD_RE.match(command, j).end()
        i = command.find("${", max(i + 2, close + 1), end)
    return end
# printf's conversions — flags, `*`/digit width, `.`/`.*`/digit precision —
# and the backslash escapes it decodes in a format (and in a `%b` argument).
_PRINTF_SPEC_RE = re.compile(r"%(%|[-+ #0']*(\*|\d+)?(?:\.(\*|\d*))?[hlLqjzt]*([a-zA-Z]))")
_PRINTF_ESC_RE = re.compile(r"\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|0?[0-7]{1,3}|.)", re.S)
# `\c` ends printf's output, there and then.
_PRINTF_STOP = "\x00turma-printf-stop"
_PRINTF_MAX_WIDTH = 256
_PRINTF_ESCAPES = {"c": _PRINTF_STOP, "n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b",
                   "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"'}
# `select` binds its list as `for` does (XERK-1650).
_FOR_IN_RE = re.compile(r"\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\s+in[ \t]+")
# `$NAME`, `${NAME}`, and the operator forms — `${d%/}`, `${d#x}`, `${d:0:4}`,
# `${nope:-/etc}`. The operator matters less than the value it operates on: a
# one-character `${d%/}` was enough to walk around the loop-variable fix.
_VAR_USE_RE = re.compile(
    r"\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)"
)
# The same groups, but `${…}` never matches: past a line's last `}` it can't,
# and letting `[^}]*` find that out rescans to the end of the line from every
# `${` there — quadratic, and a hook that times out runs the command (XERK-1596).
_VAR_BARE_RE = re.compile(
    r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?!)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)"
)


def _nest_depth(text: str, lo: int, hi: int) -> int:
    """How deep `${` openers nest in ``text[lo:hi]``, quoting ignored."""
    depth = most = 0
    for t in re.finditer(r"\$\{|\}", text[lo:hi]):
        depth = depth + 1 if t.group(0) == "${" else max(depth - 1, 0)
        most = max(most, depth)
    return most


def _var_uses(text: str):
    """``_VAR_USE_RE.finditer(text)``, in time linear in ``text`` — except a
    `${…}` whose op word nests another runs to its real `}`: cut at the inner
    one, `y=${q:+${e}x}` read as `${e}` then `x}`, and `y=${q#${nope}}` kept
    a stray `}` on /etc (XERK-1673). `_substitute_vars` reads these itself."""
    k = text.rfind("}") + 1
    last = 0
    states = None  # once per text: looked up per use, a run of them is quadratic
    for m in _VAR_USE_RE.finditer(text, 0, k):
        if m.start() < last:
            continue  # inside a nested use already yielded
        if m.group(1) and "${" in m.group(2):
            if states is None:
                states = _quote_states(text)
            close = _brace_end(text, m.start(), states[m.start()] == '"')
            # Past `_MAX_NESTED_VARS` levels the flat match stays: each level
            # is a recursion in the callers, and `_substitute_vars` already
            # refuses that line as too large.
            if close >= m.end() and _nest_depth(text, m.start(), close) <= _MAX_NESTED_VARS:
                # Each caller re-reads the op word a level down, so the work
                # is charged: 200 levels of a 40 KB value took 49s uncharged.
                _spend(close - m.start())
                m = _NestedUse(text, m.start(), m.group(1), close + 1)
        last = m.end()
        yield m
    for m in _VAR_BARE_RE.finditer(text, max(k, last)):
        yield m


class _NestedUse:
    """A `${name…}` use whose operator holds a nested `${…}`, spanning to its
    real `}` — the shape `_VAR_USE_RE` cuts at the inner one's `}`."""

    def __init__(self, text: str, start: int, name: str, end: int):
        self.string, self._start, self._end = text, start, end
        self._groups = (text[start:end], name, text[start + 2 + len(name):end - 1], None)

    def group(self, n: int = 0):
        return self._groups[n]

    def start(self) -> int:
        return self._start

    def end(self) -> int:
        return self._end


def _var_sub(repl, text: str, nested: bool = False) -> str:
    """``_VAR_USE_RE.sub(repl, text)``, in time linear in ``text``.

    With ``nested``, a use whose operator nests a `${…}` (`${a#${b:-x}}`) is
    handed whole, to its real `}`, for a ``repl`` that reads the operator: cut
    at the inner `}`, `c="${a#${b:-x}}"` bound `x/etc}` and `rm -rf "$c"` hid
    `/etc` (XERK-1668). Past `_MAX_NESTED_VARS` levels it is cut as before:
    each level is a recursion of the ``repl`` reading it."""
    out, last = [], 0
    for m in _var_uses(text):
        if m.start() < last:
            continue  # inside a nested use already handed whole
        if nested and m.group(1) and "${" in m.group(2):
            close = _brace_end(text, m.start(), False)
            if close >= m.end() and text.count("${", m.start() + 2, close) <= _MAX_NESTED_VARS:
                m = _NestedUse(text, m.start(), m.group(1), close + 1)
        out += (text[last:m.start()], repl(m))
        last = m.end()
    out.append(text[last:])
    return "".join(out)

# The expansion operators, longest spelling first so `##` never matches as `#`.
_VAR_OP_RE = re.compile(r"^(##|#|%%|%|:-|:=|:\+|-|=|\+|//|/|:)(.*)$", re.DOTALL)

# The operators that supply a literal when the name is UNSET. These need no
# assignment anywhere, so `rm -rf ${nope:-/etc}` names /etc outright.
_VAR_DEFAULT_OPS = {":-", "-", ":=", "="}

# A bash glob as `_glob_tokens` reads it: `*`, `?`, a literal character, or a
# bracket class (a compiled one-character regex). Objects, never strings, so a
# literal `\*` can't read as the wildcard.
_GLOB_STAR, _GLOB_ANY = object(), object()
_POSIX_CLASSES = {
    "alpha": "a-zA-Z", "digit": "0-9", "alnum": "a-zA-Z0-9", "upper": "A-Z",
    "lower": "a-z", "space": r" \t\n\r\f\v", "blank": r" \t", "xdigit": "0-9A-Fa-f",
    "punct": re.escape("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"), "cntrl": r"\x00-\x1f\x7f",
    "print": r"\x20-\x7e", "graph": r"\x21-\x7e", "word": r"\w",
}
# What a trim or replace may cost: matching is O(value x pattern) per start,
# and a replace tries every start. Past these the pattern counts as unreadable.
_VAR_OP_TRIM_COST = 1 << 18
_VAR_OP_REPLACE_COST = 1 << 16
# An extglob match's budget, in positions visited (`_ext_ends`): `!(…)` and a
# star inside a group reach every later end, so it is O(value² x pattern).
_VAR_OP_EXT_STEPS = 1 << 18
# How deep extglob groups nest before the pattern counts as unreadable.
_EXTGLOB_DEPTH = 16


def _glob_class(pat: str, i: int):
    """The bracket class opening at ``pat[i]`` (`[`) and the index past its `]`,
    or None when it never closes (bash then reads the `[` literally)."""
    j = i + 1
    neg = j < len(pat) and pat[j] in "!^"
    j += neg
    parts, first = [], True
    while j < len(pat):
        c = pat[j]
        if c == "]" and not first:
            body = "".join(parts)
            return re.compile("[" + "^" * neg + body + "]" if body else "[^\\s\\S]"), j + 1
        first = False
        if c == "[" and pat.startswith("[:", j):
            k = pat.find(":]", j + 2)
            name = pat[j + 2:k] if k > 0 else ""
            if name in _POSIX_CLASSES:
                parts.append(_POSIX_CLASSES[name])
                j = k + 2
                continue
        if c == "\\" and j + 1 < len(pat):
            j += 1
            c = pat[j]
        if c == "-" and parts and j + 1 < len(pat) and pat[j + 1] != "]":
            parts.append("-")
        else:
            parts.append(re.escape(c))
        j += 1
    return None


class _GlobExt(NamedTuple):
    """An extglob group as `_glob_tokens` reads it with extglob on: its kind
    (`?*+@!`) and each `|` alternative's tokens."""
    kind: str
    alts: tuple


class _GlobTooCostly(Exception):
    """An extglob match past its step budget (`_VAR_OP_EXT_STEPS`)."""


_EXTGLOB_RE = re.compile(r"[?*+@!]\(")


def _extglob_close(pat: str, i: int) -> tuple[list[str], int] | None:
    """The alternatives of the extglob group whose `(` is ``pat[i]``, and the
    index past its `)`; None when it never closes."""
    alts, depth, j, last = [], 1, i + 1, i + 1
    while j < len(pat):
        c = pat[j]
        if c == "\\":
            j += 2
            continue
        if c in "'\"":
            k = pat.find(c, j + 1)
            if k < 0:
                return None
            j = k + 1
            continue
        if c == "[" and _glob_class(pat, j):
            j = _glob_class(pat, j)[1]
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if not depth:
                return alts + [pat[last:j]], j + 1
        elif c == "|" and depth == 1:
            alts.append(pat[last:j])
            last = j + 1
        j += 1
    return None


def _glob_tokens(pat: str, extglob: bool = False, depth: int = 0) -> list | None:
    """A `${v#pat}`-style pattern as bash matches it — quotes and `\\` make text
    literal, `[...]` takes POSIX classes — or None when it can't be read here:
    an expansion still in it. With ``extglob`` (bash's `shopt -s extglob`) a
    `+(a|b)`-style group is a `_GlobExt`; without it, its text is plain glob."""
    toks: list = []
    i = 0
    while i < len(pat):
        c = pat[i]
        if c in "$`":
            return None
        if extglob and c in "?*+@!" and pat.startswith("(", i + 1):
            got = _extglob_close(pat, i + 1)
            if got is None or depth >= _EXTGLOB_DEPTH:
                return None  # unclosed (bash reads it neither way), or too deep
            alts = [_glob_tokens(a, True, depth + 1) for a in got[0]]
            if any(a is None for a in alts):
                return None
            toks.append(_GlobExt(c, tuple(tuple(a) for a in alts)))
            i = got[1]
            continue
        if c == "\\":
            toks.append(pat[i + 1] if i + 1 < len(pat) else "\\")
            i += 2
            continue
        if c == "'":
            k = pat.find("'", i + 1)
            if k < 0:
                return None
            toks.extend(pat[i + 1:k])
            i = k + 1
            continue
        if c == '"':
            i += 1
            while i < len(pat) and pat[i] != '"':
                if pat[i] in "$`":
                    return None
                if pat[i] == "\\" and i + 1 < len(pat) and pat[i + 1] in '$`"\\':
                    i += 1
                toks.append(pat[i])
                i += 1
            if i >= len(pat):
                return None
            i += 1
            continue
        if c == "*":
            if not toks or toks[-1] is not _GLOB_STAR:
                toks.append(_GLOB_STAR)
        elif c == "?":
            toks.append(_GLOB_ANY)
        elif c == "[" and _glob_class(pat, i):
            cls, i = _glob_class(pat, i)
            toks.append(cls)
            continue
        else:
            toks.append(c)
        i += 1
    return toks


def _glob_reversed(toks) -> list:
    """``toks`` matching the reversed string: a suffix match is a prefix match
    of the reversed value."""
    return [_GlobExt(t.kind, tuple(tuple(_glob_reversed(a)) for a in t.alts))
            if isinstance(t, _GlobExt) else t for t in reversed(toks)]


def _glob_ends(toks: list, value: str, start: int, memo: dict | None = None) -> list[int]:
    """Every end ``e`` with ``value[start:e]`` matching ``toks``, ascending.
    A state set run, so it costs O(len(value) x len(toks)), whatever the stars.
    An extglob group goes to `_ext_ends` (``memo`` shared across starts); past
    its step budget that raises `_GlobTooCostly`."""
    if any(isinstance(t, _GlobExt) for t in toks):
        memo = {"steps": _VAR_OP_EXT_STEPS} if memo is None else memo
        return sorted(_ext_ends(tuple(toks), value, start, memo))
    n = len(toks)

    def closure(states: set) -> set:
        for j in sorted(states):
            while j < n and toks[j] is _GLOB_STAR:
                j += 1
                states.add(j)
        return states

    states, ends = closure({0}), []
    for e in range(start, len(value) + 1):
        if n in states:
            ends.append(e)
        if e == len(value) or not states:
            break
        c, nxt = value[e], set()
        for j in states:
            if j == n:
                continue
            t = toks[j]
            if t is _GLOB_STAR:
                nxt.add(j)
            elif t is _GLOB_ANY or (t == c if isinstance(t, str) else t.match(c)):
                nxt.add(j + 1)
        states = closure(nxt)
    return ends


def _ext_ends(toks: tuple, value: str, start: int, memo: dict) -> set[int]:
    """`_glob_ends` for tokens holding an extglob group: the ends as a set of
    positions advanced token by token, each group's ends memoised per start."""
    pos, n = {start}, len(value)
    for t in toks:
        if not pos:
            break
        memo["steps"] -= len(pos)
        if memo["steps"] < 0:
            raise _GlobTooCostly
        if t is _GLOB_STAR:
            memo["steps"] -= n + 1 - min(pos)
            pos = set(range(min(pos), n + 1))
        elif isinstance(t, _GlobExt):
            ends = [_ext_group_ends(t, p, value, memo) for p in pos]
            memo["steps"] -= sum(map(len, ends))
            if memo["steps"] < 0:
                raise _GlobTooCostly
            pos = set().union(*ends)
        else:
            pos = {p + 1 for p in pos if p < n and (
                t is _GLOB_ANY or (t == value[p] if isinstance(t, str) else t.match(value[p])))}
    return pos


def _ext_group_ends(t: _GlobExt, p: int, value: str, memo: dict) -> frozenset:
    """Where extglob group ``t`` matched from ``p`` may end, as bash reads it:
    `@` one alternative, `?` at most one, `*`/`+` any/one-or-more in a row,
    `!` anything from ``p`` no alternative matches."""
    key = (id(t), p)
    if key in memo:
        return memo[key]

    def alts(q: int) -> frozenset:
        k = (id(t), "alt", q)
        if k not in memo:
            ends = [_ext_ends(a, value, q, memo) for a in t.alts]
            memo["steps"] -= sum(map(len, ends))
            if memo["steps"] < 0:
                raise _GlobTooCostly
            memo[k] = frozenset().union(*ends)
        return memo[k]

    if t.kind == "@":
        got = set(alts(p))
    elif t.kind == "?":
        got = alts(p) | {p}
    elif t.kind == "!":
        memo["steps"] -= len(value) + 1 - p
        if memo["steps"] < 0:
            raise _GlobTooCostly
        got = set(range(p, len(value) + 1)) - alts(p)
    else:
        got = {p} if t.kind == "*" else set()
        todo, seen = [p], {p}
        while todo:
            for e in alts(todo.pop()):
                got.add(e)
                if e not in seen:
                    seen.add(e)
                    todo.append(e)
    memo["steps"] -= len(got)
    if memo["steps"] < 0:
        raise _GlobTooCostly
    memo[key] = frozenset(got)
    return memo[key]


def _split_replace(arg: str) -> tuple[str, str]:
    """`${v/pat/rep}`'s ``arg`` cut at the `/` that ends the pattern — not an
    escaped one, nor one in quotes or a bracket class."""
    i = 0
    while i < len(arg):
        c = arg[i]
        if c == "\\":
            i += 2
            continue
        if c in "'\"":
            k = arg.find(c, i + 1)
            i = len(arg) if k < 0 else k + 1
            continue
        if c == "[" and _glob_class(arg, i):
            i = _glob_class(arg, i)[1]
            continue
        if c == "/" and i:
            return arg[:i], arg[i + 1:]
        i += 1
    return arg, ""


def _unreadable_op(value: str) -> str:
    """What an op the guard can't evaluate yields. Left whole, a value holding
    blanks stays ONE quoted word, so `"${a%%[[:space:]]*}"` hid `rm`
    (XERK-1651): led by `_UNREAD_OUTPUT`, as a program it is refused, and its
    words still reach a path rule. A value with no blank is kept as it is."""
    return _UNREAD_OUTPUT + " " + value if re.search(r"\s", value) else value


_PATTERN_SUBST_RE = re.compile(r"\$\([^()]*\)|`[^`]*`")
_CASE_OPS = {",,": str.lower, "^^": str.upper,
             ",": lambda v: v[:1].lower() + v[1:], "^": lambda v: v[:1].upper() + v[1:],
             # bash 5's transforms: `y=EVAL; ${y@L}` is `eval` (XERK-1666).
             # `@E` decodes escapes: `y='\x65val'; z=${y@E}; $z` runs eval.
             "@L": str.lower, "@U": str.upper, "@u": lambda v: v[:1].upper() + v[1:],
             "@E": lambda v: _decode_escapes(v), "@P": lambda v: _prompt_expanded(v)}


def _decoding_op(tail: str | None) -> str | None:
    """`@E` / `@P` when ``tail`` (what follows a name in `${…}`) is one,
    after one balanced subscript too: `${y[0]@E}`, `${y[i[0]]@P}`,
    `${y[']']@E}` (XERK-1666 QA). Never an op whose word ends so:
    `${y[0]%]@E}` is a trim by the pattern `]@E`."""
    if not tail or "@" not in tail:
        return None
    k = 0
    if tail[0] == "[":
        # Bash's own search for the closing `]`: quotes, a `\\`-escaped
        # character, and a `$(…)` / `${…}` / backtick span hide one.
        depth, quote, n = 0, "", len(tail)
        spans = {m.start(): m.end() for m in _find_substs(tail)} if "$(" in tail or "`" in tail else {}
        while k < n:
            c = tail[k]
            if quote == "'":
                quote = "" if c == "'" else quote
            elif c == "\\":
                k += 1
            elif quote == '"' and c == '"':
                quote = ""
            elif c in "'\"" and not quote:
                quote = c
            elif k in spans:
                k = spans[k] - 1
            elif tail.startswith("${", k):
                # Quoting passed in: looked up, it was re-read per span (QA).
                k = _brace_end(tail, k, quote == '"')
                if k < 0:
                    return None
            elif quote:
                pass
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if not depth:
                    break
            k += 1
        else:
            return None
        k += 1
    return tail[k:] if tail[k:] in ("@E", "@P") else None


_ESCAPE_RE = re.compile(r"\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)",
                        re.DOTALL)
_ESCAPE_CHARS = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
                 "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"'}


def _decode_escapes(value: str) -> str:
    """``value`` with its backslash escapes decoded, as `$'…'` and `@E` do."""
    def one(m: "re.Match[str]") -> str:
        e = m.group(1)
        if e[0] == "c" and len(e) == 2:
            return chr(ord(e[1]) & 0x1F)  # `\cX` is control-X; `\c@` a NUL
        try:
            if e[0] in "xuU" and len(e) > 1:
                return chr(int(e[1:], 16))
            if e[0] in "01234567":
                return chr(int(e, 8) & 0xFF)
        except ValueError:
            return m.group(0)
        return _ESCAPE_CHARS.get(e, m.group(0))
    if "\\" not in value:
        return value
    # Bash ends the value at a decoded NUL: `eval\0x` is `eval`.
    return _ESCAPE_RE.sub(one, value).split("\0", 1)[0]


def _prompt_expanded(value: str) -> str:
    r"""`${y@P}`: a prompt expansion, which reads `\s`, `\u`, `\w` as the
    shell, user, cwd and runs a `$(…)` in the value. Not modelled: a value
    with any `\`, `$` or backtick is unreadable, led by `_UNREAD_OUTPUT`
    so as a program it is refused, its text kept for path rules."""
    return _UNREAD_OUTPUT + " " + value if re.search(r"[\\$`]", value) else value


def _pattern_vars(arg: str, vals: dict[str, list[str]], keep: bool = False) -> str:
    """The names in an op's pattern, replacement or offset spliced in as text,
    where they then act as pattern (or, quoted, literal) as bash reads them:
    `"${a%%$s*}"`, `${a#"${a%% *}"}`. An unassigned `IFS` is bash's default.
    A name not assigned here, and a `$(…)`, read EMPTY — or with ``keep``, stay
    as written (see `_brace_trailing`): bash may fill them (`$HOME`, `$PWD`), so `_op_readings` takes
    both."""
    if "$" not in arg and "`" not in arg:
        return arg
    if "${!" in arg:
        # `${!x}` is the variable x's value names: `y=eval; x=y; ${!x}` is
        # `eval` (XERK-1666), with any op or element applied to that name
        # (`${!x,,}`, `${!x[0]}`, x='y[0]'). A value that is no name is left
        # as written, as is `${!x[@]}` / `${!x*}`: those list names, not values.
        def indirect(m: "re.Match[str]") -> str:
            target = _picked(vals.get(m.group(1)) or [""], m.group(1))
            if not _INDIRECT_TARGET_RE.fullmatch(target):
                return m.group(0)
            return "${" + target + m.group(3) + "}"
        arg = _INDIRECT_OP_RE.sub(indirect, arg)

    def rep(u: "re.Match[str]") -> str:
        name = u.group(1) or u.group(3)
        got = vals.get(name) or ([" \t\n"] if name == "IFS" else None)
        tail = u.group(2) or ""
        op = _VAR_OP_RE.match(tail)
        if not got:
            if op and op.group(1) in _VAR_DEFAULT_OPS and not keep:
                return _pattern_vars(op.group(2), vals)
            return u.group(0) if keep else ""
        value = _picked(got, name)
        if tail in _CASE_OPS:
            return _CASE_OPS[tail](value)
        if _decoding_op(tail):  # an element's `@E` too: `${y[0]@E}`
            return _CASE_OPS[_decoding_op(tail)](value)
        if tail.startswith("["):  # an element: read as the value
            return value
        if tail and not op:
            return u.group(0)
        if op and op.group(1) not in _VAR_DEFAULT_OPS:
            value = _op_readings(value, op.group(1), op.group(2), vals)[0]
        return value
    out = _var_sub(rep, arg)
    return out if keep else _PATTERN_SUBST_RE.sub("", out)


def _brace_trailing(word: str) -> str:
    """``word`` with a bare name ending it braced, so text spliced after it
    stays text: `${a/xx/$nope}` on `xxrm` would name `$noperm`. Only the
    trailing one: one mid-word is already cut off by what follows it."""
    return re.sub(r"(?<!\\)\$([A-Za-z_]\w*)\Z", r"${\1}", word)


def _op_readings(value: str, op: str, arg: str, vals: dict[str, list[str]]) -> list[str]:
    """What `${v<op><arg>}` may yield, for ``value``: one string when its
    pattern is known. A name it can't resolve, or a `$(…)`, may be unset or
    hold anything bash knows (`$PWD`, `$HOME`), and no one reading is safe:
    read empty, `${a#$PWD}` kept `/tmp` on the path; kept whole, `${a#${nope}xx}`
    hid `/etc` (XERK-1651). So it yields each reading — empty, the `$(…)` read
    as what it prints, and the value untouched — for `_splice_readings`."""
    if op in (":+", "+"):
        # An alternative is a word, not a pattern: an unknown in it stays live
        # text, as in a replacement. Read empty, `${q:+$HOME}` lost the path.
        return [_apply_var_op(value, op, _brace_trailing(_pattern_vars(arg, vals, keep=True)))]
    if op in ("/", "//"):
        pat, rep = _split_replace(arg)
        # An unknown stays live text.
        rep = _brace_trailing(_pattern_vars(rep, vals, keep=True))
    else:
        pat, rep = arg, None
    known = _pattern_vars(pat, vals, keep=True)

    def apply(p: str) -> list[str]:
        return _var_op_readings(value, op, p, rep)

    if "$" not in known.replace("$((", "((") and "`" not in known:
        return apply(known)
    printed = _PATTERN_SUBST_RE.sub(lambda m: _produced_text(m.group(0)).strip(), pat)
    out = []
    for got in (*apply(_pattern_vars(pat, vals)), *apply(_pattern_vars(printed, vals)), value):
        if got not in out:
            out.append(got)
    # Ambiguous even when every reading agrees, `${a#$PWD}` being unknown:
    # a value with blanks is led by the unread marker, as `_unreadable_op` does.
    return out if len(out) > 1 or not (re.search(r"\s", value) or _EXTGLOB_RE.search(pat)) \
        else out * 2


def _splice_readings(readings: list[str], state: str) -> str:
    """Several readings of one expansion spliced as words led by
    `_UNREAD_OUTPUT`: as a program it is refused, and each reading still
    reaches the path rules — inside `"…"` too, as separate words.

    Inside `"…"` that cuts a `bash -c "${q%x$nope} …"` script into a lone
    marker plus arguments, so the script ran unread; kept one word, every
    per-word judge but the path one (a stdin shell, `~/.ssh`, `cd /`) missed
    it (XERK-1673 QA). So both: split here, one word in the added
    `_READINGS_JOINED` reading.

    And each reading gets a whole-line pass of its own (`_READING_PICK`, set
    by `_expand_both`), spliced plainly: text glued after the op
    (`bash -c "rm -rf ${a%@(X)}tc"`) joins only the last reading in both
    marker-led forms (XERK-1664 QA)."""
    if len(readings) == 1:
        return _quote_literal(readings[0], state)
    _READINGS_MOST[0] = max(_READINGS_MOST[0], len(readings))
    if _READING_PICK[0] is not None:
        return _quote_literal(readings[min(_READING_PICK[0], len(readings) - 1)], state)
    words = [_quote_literal(w, state) for w in (_UNREAD_OUTPUT, *readings)]
    if state == '"':
        _READINGS_SEEN[0] = True
        if _READINGS_JOINED[0]:
            return " ".join(words)
    return ('" "' if state == '"' else " ").join(words)


def _arith_offset(text: str) -> int | None:
    """An `${a:off:len}` part as bash's arithmetic reads it, for the plain
    cases (`(2)`, `1+1`, `-3/2`, empty); None for anything else. Bash
    truncates `/` and `%` toward zero, as C does — never Python's floor."""
    # `$((…))` inside arithmetic is its own value: `${a:$((1+1))}` (XERK-1668).
    text = text.strip().replace("$((", "((")
    if not text:
        return 0
    if len(text) > 64 or not re.fullmatch(r"[\d\s+\-*/%()]+", text):
        return None
    try:
        tree = ast.parse(text, mode="eval").body
    except (SyntaxError, ValueError, RecursionError):
        return None

    def ev(node) -> int:
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = ev(node.operand)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.BinOp):
            x, y = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Add):
                return x + y
            if isinstance(node.op, ast.Sub):
                return x - y
            if isinstance(node.op, ast.Mult) and abs(x) < 1 << 62 and abs(y) < 1 << 62:
                return x * y
            if isinstance(node.op, (ast.Div, ast.Mod)) and y:
                q = abs(x) // abs(y) * (1 if (x < 0) == (y < 0) else -1)
                return q if isinstance(node.op, ast.Div) else x - y * q
        raise ValueError

    try:
        return ev(tree)
    except (ValueError, RecursionError):
        return None


def _var_op_readings(value: str, op: str, arg: str, rep: str | None = None) -> list[str]:
    """`${v<op><arg>}` on ``value`` read with bash's extglob off, then on when
    its pattern holds an extglob group (XERK-1664). The guard does not track
    `shopt -s extglob`, and either reading alone is a bypass: `${a##+(x)}` on
    `xx/etc` is `xx/etc` off and `/etc` on. Such an op always yields two or
    more readings, equal or not, so its callers splice it marker-led: bash's
    own extglob matcher has quirks the on reading does not model
    (`${a#*@(x|)}` on `x/etc` is `/etc`), so it is never one trusted text.
    ``rep`` set reads `${v<op><arg>/<rep>}`."""
    def one(ext: int) -> str:
        if rep is not None:
            return _replace_op(value, op, arg, rep, ext)
        return _apply_var_op(value, op, arg, ext)
    out = [one(0)]
    if op not in ("#", "##", "%", "%%", "/", "//") or not _EXTGLOB_RE.search(arg):
        return out
    for ext in (1, 2) if op[0] == "/" else (1,):
        if (got := one(ext)) not in out:
            out.append(got)
    return out if len(out) > 1 else out * 2


def _var_op_text(value: str, op: str, arg: str, rep: str | None = None) -> str:
    """`_var_op_readings` as one text: several are led by `_UNREAD_OUTPUT`,
    as `_op_readings`' callers splice them."""
    got = _var_op_readings(value, op, arg, rep)
    return got[0] if len(got) == 1 else " ".join((_UNREAD_OUTPUT, *got))


@functools.lru_cache(maxsize=256)  # one line repeats an op on one value
def _apply_var_op(value: str, op: str, arg: str, extglob: int = 0) -> str:
    """Apply a `${name<op><arg>}` expansion to a known value.

    Trims and replaces match their pattern as a bash glob (XERK-1651):
    dropping its `*`s left `"${a%% *}"` whole, one quoted word that hid `rm`.
    A pattern that can't be read here yields `_unreadable_op`. A nonzero
    ``extglob`` reads it as bash does under `shopt -s extglob` (see
    `_var_op_readings`; 2 is `_replace_matched`'s other end-match reading).
    """
    if op in ("#", "##", "%", "%%"):
        toks = _glob_tokens(arg, bool(extglob))
        if toks is None or len(value) * (len(toks) + 1) > _VAR_OP_TRIM_COST:
            return _unreadable_op(value)
        try:
            if op[0] == "#":
                ends = _glob_ends(toks, value, 0)
                return value[(ends[0] if op == "#" else ends[-1]):] if ends else value
            # A suffix is a prefix of the reversed value under the reversed pattern.
            ends = _glob_ends(_glob_reversed(toks), value[::-1], 0)
        except _GlobTooCostly:
            return _unreadable_op(value)
        return value[:len(value) - (ends[0] if op == "%" else ends[-1])] if ends else value
    if op in ("/", "//"):
        return _replace_op(value, op, *_split_replace(arg), extglob)
    if op in (":+", "+"):
        # The alternative replaces a set value: `${q:+/etc}` is /etc. Names in
        # it were expanded by `_op_readings`; one it can't resolve leaves it
        # ambiguous there.
        return arg if value or op == "+" else value
    if op == ":":
        # `${a:off}`, `${a:off:len}`: an empty part is 0 (`"${a::2}"` is `rm`,
        # XERK-1651), a negative offset counts from the end, a negative length
        # is an end offset.
        nums = [_arith_offset(b) for b in arg.split(":")[:2]]
        if None in nums:
            return _unreadable_op(value)
        start = nums[0] if nums[0] >= 0 else max(len(value) + nums[0], 0)
        if len(nums) == 1:
            return value[start:]
        end = start + nums[1] if nums[1] >= 0 else len(value) + nums[1]
        return value[start:end] if end >= start else _unreadable_op(value)
    return value


# A replacement's quoting: `\x`, `'…'`, `"…"` (its own escapes), else a char.
_REP_QUOTE_RE = re.compile(r"""\\(.)|'([^']*)'|"((?:[^"\\]|\\.)*)"|(.)""", re.S)


def _dequote_rep(rep: str) -> str:
    """A replacement after quote removal: it is never a glob."""
    def one(m: "re.Match[str]") -> str:
        if m.group(3) is not None:
            return re.sub(r'\\([$`"\\\n])', r"\1", m.group(3))
        return next(g for g in (m.group(1), m.group(2), m.group(4)) if g is not None)
    return _REP_QUOTE_RE.sub(one, rep)


@functools.lru_cache(maxsize=256)
def _replace_op(value: str, op: str, pat: str, rep: str, extglob: int = 0) -> str:
    """`${v/pat/rep}` (`op` `/` or `//`), its pattern a bash glob; `#`/`%`
    anchor it. A replacement still holding a `$` stays as written, live text
    the reading of the line then expands (`${a/X/$HOME}`)."""
    anchor = pat[0] if op == "/" and pat[:1] in ("#", "%") else ""
    toks = _glob_tokens(pat[len(anchor):], bool(extglob))
    if toks is None:
        return _unreadable_op(value)
    try:
        return _replace_matched(value, op, toks, anchor, rep, extglob == 2)
    except _GlobTooCostly:
        return _unreadable_op(value)


def _replace_matched(value: str, op: str, toks: list, anchor: str, rep: str,
                     end_empty: bool = False) -> str:
    """`_replace_op` once its pattern is read into ``toks``. ``end_empty``
    lets any pattern match empty at the value's end (see below)."""
    if "$" not in rep and "`" not in rep:
        rep = _dequote_rep(rep)
    if not toks and not anchor:
        return value
    if all(isinstance(t, str) and len(t) == 1 for t in toks) and not anchor:
        return value.replace("".join(toks), rep, -1 if op == "//" else 1)
    # An empty match at the value's end counts for a pattern led by `*`
    # (bash's `match_pattern_char`): `${v/%!(x)/-}` leaves `x` as it is. Bash's
    # matcher is not consistent here (`${v/%?(x)/-}` is `xyz-`), so with an
    # extglob `_var_op_readings` also takes the reading where any pattern may.
    end_ok = end_empty or not toks or toks[0] is _GLOB_STAR or (
        isinstance(toks[0], _GlobExt) and toks[0].kind == "*")
    if anchor == "%":
        ends = _glob_ends(_glob_reversed(toks), value[::-1], 0)
        if ends == [0] and not end_ok:
            return value
        return value[:len(value) - ends[-1]] + rep if ends else value
    if len(value) ** 2 * (len(toks) + 1) > _VAR_OP_REPLACE_COST:
        return _unreadable_op(value)
    # Replaced at the longest match from the first place it matches.
    out, i, memo = [], 0, {"steps": _VAR_OP_EXT_STEPS}
    while i <= len(value):
        ends = _glob_ends(toks, value, i, memo)
        end = ends[-1] if ends else -1
        if end == i == len(value) and not end_ok:
            end = -1
        if end == i and i < len(value) and not anchor:
            # An empty match mid-value (only an extglob makes one, `*(x)`):
            # bash puts the replacement there and steps over one character.
            out.append(rep + value[i])
            i += 1
            if op == "/":
                break
            continue
        if end > i or end == i and (anchor or not value):
            out.append(rep)
            # An empty match ends it, as `//` would otherwise never move.
            if op == "/" or end == i:
                i = end
                break
            i = end
            continue
        if anchor == "#" or i == len(value):
            break
        out.append(value[i])
        i += 1
    return "".join(out) + value[i:]


def _decode_ansi_c(command: str) -> str:
    """`$'\\x2fetc'` → `/etc`, re-quoted so it stays one token."""

    out, pos, states = [], 0, None
    while (m := _ANSI_C_RE.search(command, pos)) is not None:
        start = m.start() + len(m.group(1))  # the `$`
        if len(m.group(1)) % 2:
            out.append(command[pos:start + 2])
            pos = start + 2
            continue
        # Inside `"…"`, `'…'` or a `#` comment a `$'` is literal to bash:
        # decoded there, a `$'\x27'` became quote characters that unbalanced
        # the line, and a comment's `$'\nx'` ended the comment and opened a
        # quote over the next line (XERK-1693 QA). Always asked: a shortcut
        # on the line holding a quote skipped the comment case. Step past
        # its `$'` only: the match may run over a real `$'…'` after it.
        if states is None:
            states = _quote_states(command)
        if states[start] or not _ansi_c_dollar(command, start):
            out.append(command[pos:start + 2])
            pos = start + 2
            continue
        out += (command[pos:start], shlex.quote(_ansi_c_text(m.group(2))))
        pos = m.end()
    out.append(command[pos:])
    return "".join(out)


# bash's `$'…'` single-character escapes.
_ANSI_C_SIMPLE = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
                  "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?"}
# `\xHH`, `\uHHHH`, `\UHHHHHHHH`: how many hex digits each takes at most.
_ANSI_C_HEX = {"x": 2, "u": 4, "U": 8}


def _ansi_c_text(body: str) -> str:
    """The text bash makes of a `$'…'` body, by bash's rules, never failing.

    Python's `unicode_escape` raised on escapes bash accepts (a bare `\\x`,
    `\\x4`, `\\u41`), and the string was then left undecoded, so one such
    escape hid the whole script: `bash -c $'rm -rf /etc; : \\x'` (XERK-1693).
    An unknown escape keeps its backslash; a NUL ends the string, as in bash."""
    out, i, n = [], 0, len(body)
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        esc = body[i + 1]
        i += 2
        if esc in _ANSI_C_SIMPLE:
            out.append(_ANSI_C_SIMPLE[esc])
        elif esc in "01234567":
            j = i
            while j < n and j < i + 2 and body[j] in "01234567":
                j += 1
            out.append(chr(int(esc + body[i:j], 8) & 0xFF))
            i = j
        elif esc in _ANSI_C_HEX:
            j = i
            while j < n and j < i + _ANSI_C_HEX[esc] and body[j] in string.hexdigits:
                j += 1
            if j == i:
                out.append("\\" + esc)
            else:
                code = int(body[i:j], 16)
                out.append(chr(code) if code <= 0x10FFFF else "\ufffd")
            i = j
        elif esc == "c" and i < n:
            # `\cX` is control-X; `\c\\` takes the escaped backslash. bash
            # takes X's first UTF-8 byte and keeps its others (`\cé` = 03 a9).
            x = body[i]
            i += 2 if x == "\\" and body[i + 1:i + 2] == "\\" else 1
            lead, *rest = x.encode("utf-8", "surrogatepass")
            out.append("\x7f" if x == "?" else chr(lead & 0x1F) + bytes(rest).decode("latin-1"))
        else:
            out.append("\\" + esc)
    text = "".join(out)
    return text.split("\0", 1)[0]


def _brace_sequence(body: str) -> list[str] | None:
    """The words a `{x..y[..step]}` sequence expands to, or None."""
    m = _BRACE_SEQ_RE.fullmatch(body)
    if not m:
        return None
    a, b, step = m.group(1), m.group(2), abs(int(m.group(3) or 1)) or 1
    if a.lstrip("-").isdigit() != b.lstrip("-").isdigit():
        return None
    lo, hi = (int(a), int(b)) if a.lstrip("-").isdigit() else (ord(a), ord(b))
    if abs(hi - lo) // step >= _BRACE_SEQ_MAX:
        return None
    seq = range(lo, hi + 1, step) if lo <= hi else range(lo, hi - 1, -step)
    return [str(v) if a.lstrip("-").isdigit() else chr(v) for v in seq]


def _brace_word_start(command: str, start: int, cut: int) -> int:
    """Where the bash word holding the brace at ``start`` begins, quotes and
    substitutions read: `"$(echo a b)"{1,2}` and `'x y'{,z}` are one word
    each (XERK-1683). ``cut`` (the last blank before it) when nothing
    between can join a word across a blank."""
    quoted = any(c in command[cut:start] for c in "'\"\\")
    if not quoted and "`" not in command[cut:start] and not (cut and command[cut - 1] == ")"):
        return cut
    # Words are scanned from the innermost substitution body holding the
    # brace, where bash starts splitting words afresh.
    origin, end = 0, len(command)
    while True:
        inner = next((m for m in _find_substs(command[origin:end])
                      if origin + m.start() < start < origin + m.end() - 1), None)
        if inner is None:
            break
        tick = command[origin + inner.start()] == "`"
        origin, end = origin + inner.start() + (1 if tick else 2), origin + inner.end() - 1
        if tick:
            break  # a backtick body is unescaped: its nested offsets differ
    i = origin
    while i < start:
        if command[i] in _BRACE_WORD_END:
            i += 1
            continue
        w = _word_end(command, i)
        if w < 0 or w > start:
            # Only ever further back than the cut. With no quote between, a
            # word across a newline is a backtick misread in data (a Go raw
            # string in a heredoc), never one bash forms.
            return i if i < cut and (quoted or "\n" not in command[i:cut]) else cut
        i = w
    return cut


def _expand_braces(command: str) -> str:
    """`rm -rf {/etc,/var}` → `rm -rf /etc /var` (prefix/suffix preserved).

    A QUOTED brace is text — bash expands none inside `'…'` or `"…"`, and
    rewriting `awk '{print $2,$4}'` unbalanced its quotes (XERK-1256). A quoted
    script handed to `bash -c`/`eval` is re-expanded unquoted where it runs.
    """
    masked = _mask_param_braces(command)
    if masked is not None:
        command, back = masked
    pos = 0
    expansions = 0
    states = _quote_states(command)
    while expansions < 4:  # bounded: an expansion can re-create a brace
        m = _BRACE_RE.search(command, pos)
        if not m:
            break
        start, end = m.span()
        # `${x,,}` is a case-modifying parameter expansion, never a brace
        # list: expanded, `${x,,}rm` read as `$xrm $rm $rm` (XERK-1615).
        items = m.group(1).split(",") if "," in m.group(1) else _brace_sequence(m.group(1))
        if states[start] or not items \
                or (start and command[start - 1] == "$" and _live_dollar(command, start - 1)):
            pos = start + 1
            continue
        expansions += 1
        # A word ends at a blank or an operator: cut only at a space,
        # `{,bash}|cat` read as `|cat bash|cat` (XERK-1629).
        word_start = start
        while word_start and command[word_start - 1] not in _BRACE_WORD_END:
            word_start -= 1
        # A quoted run glued before the brace is the word's too: cut at a
        # quoted blank, `eval 'rm -rf /etc'{,x}` read as `'rm -rf /etc' /etc'x`
        # (XERK-1683). An ADDED reading (`_BRACE_QUOTED`), never in place of
        # the cut one: no lexer short of bash finds every word start.
        quoted_start = _brace_word_start(command, start, word_start)
        if quoted_start != word_start:
            _BRACE_QUOTED_SEEN[0] = True
            if _BRACE_QUOTED[0]:
                word_start = quoted_start
        # A `$(…)`, backtick or quoted run glued on is the word's too: cut at
        # its `(`, `{,}$(echo rm -rf /)` read as `$ $` (XERK-1622).
        word_end = _word_end(command, end)
        if word_end < 0:
            m_end = _BRACE_WORD_END_RE.search(command, end)
            word_end = m_end.start() if m_end else len(command)
        prefix, suffix = command[word_start:start], command[end:word_end]
        # An empty word goes, as in bash: `{,bash}` runs `bash`.
        parts = [w for w in (prefix + p.strip() + suffix for p in items) if w]
        # A suffix ending in a lone `\` (the word ends the text) escaped the
        # blank joining two words: `{/etc,/var}\` read as ONE word
        # `/etc /var\`. zsh drops that `\` before it expands; bash keeps it
        # literal on every word, which judges no worse (XERK-1646).
        if suffix.endswith("\\") and _drop_trailing_escape(command[:word_end]) is not None:
            parts = [w[:-1] for w in parts if w[:-1]]
        command = command[:word_start] + " ".join(parts) + command[word_end:]
        pos = word_start
        states = _quote_states(command)
    if masked is not None:
        command = _unmask_param_braces(command, back)
    return command


def _mask_param_braces(command: str) -> tuple[str, dict[str, str]] | None:
    """``command`` with each brace unit bash keeps whole inside a brace list
    swapped for a stand-in the text does not hold, and the map back; None
    when there is none.

    `_BRACE_RE` cannot span braces or blanks, so a list holding a unit was
    never expanded: it found only the inner `{HOME}`, skipped it as a
    parameter, and `rm -rf {/tmp/x,${HOME}}` went unread (XERK-1694).
    `"$HOME"` reaches here braced too (`_brace_quote_ended`). Units:
    - a live `${…}` that is not single-quoted: `${` inhibits brace expansion
      to its `}`, so `{x,${y:-a,b}}` is two items. bash counts plain `{…}`
      inside it (`${y:-{a}}` is one unit), which `_brace_end` does not;
    - a live `$(…)` or backtick (one word: `{x,$(echo /etc)}`).
    A literal non-list brace (`{x,{a},/etc}`) is NOT masked (XERK-1756):
    in readings that see quoted JSON bare, unblocking its lists multiplied
    the readings, and real commands went past the deadline (6x).
    """
    if "${" not in command and "$(" not in command and "`" not in command \
            or not _LIST_OPENER_RE.search(command):
        return None  # nothing to mask, or no `{` a list could open with
    states = _quote_states(command)
    n = len(command)
    spans: list[tuple[int, int]] = []
    in_sub = bytearray(n)
    for m in _find_substs(command):
        s, e = m.start(), m.end()
        in_sub[s:e] = b"\x01" * (e - s)
        if command[s] in "$`" and states[s] in ("", '"') \
                and (command[s] == "`" or _live_dollar(command, s)):
            spans.append((s, e))
    unclosed = False
    i = command.find("${")
    while i >= 0:
        end = -1
        if states[i] in ("", '"') and not in_sub[i] and _live_dollar(command, i):
            end = _brace_end(command, i, states[i] == '"')
        if end >= 0 and not unclosed:
            # Plain braces counted as bash does. One that never balances keeps
            # `_brace_end`'s close, and stops the count for the rest of the
            # line: a scan to the end per opener is quadratic.
            depth, k, quoting = 1, i + 2, states[i]
            while k < n:
                if not in_sub[k] and states[k] == quoting:
                    if command[k] == "{":
                        depth += 1
                    elif command[k] == "}":
                        depth -= 1
                        if not depth:
                            break
                k += 1
            if k >= n:
                unclosed = True
            elif k > end:
                end = k
        if end < 0:
            i = command.find("${", i + 2)
            continue
        spans.append((i, end + 1))
        i = command.find("${", end + 1)
    if not spans:
        return None
    have = set(command)
    free = list(itertools.islice((chr(c) for c in range(0xE000, 0xF900) if chr(c) not in have),
                                 _BRACE_MASK_DIGITS + 1))
    if len(free) < 2:
        raise _ExpansionTooLarge  # a list left unread fails open: refuse
    # A lead stand-in then two digit stand-ins: room for more units than any
    # command under the growth budget holds, so none stays unread.
    lead, digits = free[0], free[1:]
    base = len(digits)
    back: dict[str, str] = {}

    def stand_in(text: str) -> str:
        if len(back) >= base * base:
            raise _ExpansionTooLarge  # as above, past the stand-ins
        stand = lead + digits[len(back) // base] + digits[len(back) % base]
        back[stand] = text
        return stand

    out, last = [], 0
    for s, e in sorted(spans):
        if s < last:
            continue  # inside an outer unit already masked
        stand = stand_in(command[s:e])
        out.append(command[last:s] + stand)
        last = e
    out.append(command[last:])
    return "".join(out), back


# `_mask_param_braces`'s stand-ins' digit count: two digits name 65536 units.
_BRACE_MASK_DIGITS = 256
# A `{` that is not a `${`'s, or follows an escaped `\$`: only such a one opens a
# brace list (bash expands `\${a,b}` to `$a $b`).
_LIST_OPENER_RE = re.compile(r"(?<!\$)\{|\\\$\{")


def _unmask_param_braces(command: str, back: dict[str, str]) -> str:
    """``command`` with `_mask_param_braces`'s stand-ins put back."""
    lead = next(iter(back))[0]
    if lead not in command:
        return command
    parts = command.split(lead)
    return parts[0] + "".join(back.get(lead + p[:2], lead + p[:2]) + p[2:] for p in parts[1:])


@_budgeted
def _var_values(command: str) -> dict[str, list[str]]:
    """Values this command line itself assigns to a variable."""
    # A `\\<newline>` inside a value is no part of it: unjoined, it cut
    # `x="… \\<newline>rm …"` to an empty value (XERK-1615).
    return _memo("vals", command, _assigned_values, _join_continuations(command))


def _eval_named(word: str, known: dict[str, list[str]],
                split: dict[str, list[str]] | None = None) -> bool:
    """Whether names spell `eval` in ``word``, through a few hops of names
    holding names (`x=eval; z=$x; $z`, `x=y; ${!x}`): values here are not yet
    resolved. A name with several values is also read with each alone, as
    bash binds one at a time: joined, `for e in ls eval` read `ls eval`."""
    split = split or {}
    if _eval_named_joined(word, known):
        return True
    # A `for` list word that splits into fields binds each in turn (`x='ls
    # eval'; for e in $x`), which no per-word reading separates: each alone.
    several = [n for n in dict.fromkeys(u.group(1) or u.group(3) for u in _var_uses(word))
               if n in split][:4]
    for n in several:
        for v in split[n]:
            if _eval_named_joined(word, {**known, n: [v]}):
                return True
    return False


def _eval_named_joined(word: str, known: dict[str, list[str]]) -> bool:
    for _ in range(3):
        if _spells_eval(_pattern_vars(word, known)):  # unknowns empty
            return True
        word = _pattern_vars(word, known, keep=True)
        if "$" not in word:
            break
    return _spells_eval(word)


def _unquoted_dollar(word: str) -> bool:
    """Whether a `$` in ``word`` stands outside quotes, where bash splits
    what it expands."""
    states = _quote_states(word)
    return any(c == "$" and not states[k] for k, c in enumerate(word))


def _spells_eval(text: str) -> bool:
    """Whether ``text``, a resolved command word, is `eval` as bash reads it:
    its quotes and backslashes removed (`ev'al'`, a value `ev\\al`, XERK-1666)."""
    if _basename(text) == "eval":
        return True
    # Only removal can make it `eval`, so its letters must end the text with
    # quotes cut: a cheap test before dequoting a large spliced value.
    if not re.sub(r"['\"\\]", "", text).lower().endswith("eval"):
        return False
    bare = re.sub(r"\\(.)", r"\1", _dequote_value(text))
    return bare != text and _basename(bare) == "eval"


# How deep an `eval`'s own assignments are read: `x='eval "$x"'; eval "$x"`
# would otherwise re-read itself forever.
_EVAL_ASSIGN_DEPTH = 3


_ASSIGN_DEFAULT_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*):?=")
# `${!name}`: the variable ``name``'s value names (XERK-1634).
_INDIRECT_RE = re.compile(r"\$\{!([A-Za-z_][A-Za-z0-9_]*)\}")
# ...and with an element or op after it: `${!x[0]}`, `${!x,,}` (XERK-1666).
# Not `${!x[@]}` / `${!x*}` / `${!x@}`: those list keys or names; `${!x@L}` is
# x's target transformed.
_INDIRECT_OP_RE = re.compile(
    r"\$\{!([A-Za-z_][A-Za-z0-9_]*)(\[(?![@*]\])[^]]*\])?((?![*@]\})[^}]*)\}")
_MAYBE_EVAL_RE = re.compile(r"\$\{!|@[A-Za-z]\}")
_LOCALE_QUOTE_RE = re.compile(r'(?<![\\$])\$(?=")')
# What an indirection may name: a variable, or one element of one.
_INDIRECT_TARGET_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]*\])?")


_ALTERNATIVE_RE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:?\+")


def _alternatives_taken(word: str) -> str:
    """``word`` with each `${x:+alt}` / `${x+alt}` read as ``alt``: x may be
    set (`$PATH` always is), and with no value `_substitute_vars` never takes
    that branch (XERK-1634 comment, routes: assignment, `for`, `read <<<`)."""
    out, last = [], 0
    for m in _ALTERNATIVE_RE.finditer(word):
        if m.start() < last:
            continue
        close = _brace_end(word, m.start())
        if close < m.end():
            continue
        out += (word[last:m.start()], word[m.end():close])
        last = close + 1
    out.append(word[last:])
    return "".join(out)


def _default_readings(word: str) -> list[str]:
    """A `${…}` word's values with a default applied (`_substitute_vars` with
    no values) and with an alternative taken (`_alternatives_taken`)."""
    out = [_dequote_value(_substitute_vars(word, {}))]
    if "+" in word:
        taken = _alternatives_taken(word)
        if taken != word:
            out.append(_dequote_value(_substitute_vars(taken, {})))
    return out


def _assigned_values(command: str, depth: int = 0,
                     env: dict[str, list[str]] | None = None) -> dict[str, list[str]]:
    vals: dict[str, list[str]] = {}
    states = _quote_states(command) if "${" in command else []
    applied: dict[str, list[str]] = {}
    # Where each value of ``vals`` / ``applied`` is assigned in ``command``,
    # None where no one place does (`read`, `printf -v`, an `eval`'s), for the
    # ordered reading (`_ordered_values`, XERK-1660).
    where: dict[str, list[int | None]] = {}
    applied_where: dict[str, list[int]] = {}
    # Positions whose captured value ran PAST its statement: a `${…}` the
    # regex extended over an unquoted `;`/newline/redirect (`rest=${m#*|}
    # python3 … <<EOF`). Read in order, that text reached a program word, so
    # these stay order-blind (`_ordered_values`, XERK-1660). A quoted
    # separator (`d="$q$c ;"`) is part of the value and IS read in order.
    misparse: set[int] = set()
    for m in _VAR_ASSIGN_RE.finditer(command):
        value = m.group(2)
        if "${" in value and not _MAIN_PARSE[0]:
            value = command[m.start(2):_assign_value_end(command, states, m.start(2), m.end(2))]
        if value.startswith("(") and value.endswith(")"):
            # An array, `a=(rm -rf *)`: its words, which `"${a[@]}"` runs.
            value = value[1:-1].strip()
            # ...and each element on its own, which `"${a[1]}"` runs
            # (XERK-1634); a few, as each is a reading.
            # `([1]=w …)` names its index; the element is `w`.
            elements = [re.sub(r"\A\[[^]]*\]\+?=", "", w.group(0))
                        for w in _ASSIGN_WORD_RE.finditer(value) if w.group(0)]
            # One element too, when written with its index (`([k]=w)`).
            if elements and len(elements) <= _MAX_VALUE_READINGS // 2 and (
                    len(elements) > 1 or elements[0] != value):
                for element in elements:
                    vals.setdefault(m.group(1), []).append(
                        _produced_text(_dequote_value(element), multi=_VALUES_MULTI[0]))
                    where.setdefault(m.group(1), []).append(m.start())
        raw = value
        if "${" in raw and _ORDER_MISPARSE_RE.search(raw):
            rs = _quote_states(raw)
            if any(raw[j] in ";\n<>" and not rs[j] for j in range(len(raw))):
                misparse.add(m.start())
        # Read as before XERK-1609 unless `_expand_both` is on its pass for
        # several statements (see `_body_printed`). Both in one list was no
        # good: `_substitute_vars` joins a name's values into ONE word list,
        # and `x=$(echo sh; true); echo P | $x` read as `sh sh; true`.
        # Its printed lines are words to `$x`, which bash word-splits; read
        # as lines they split `rm $x` into two commands.
        value = _dequote_value(value)
        produced = _produced_text(value)
        # The taint reading of a filtered or conditional body, which neither
        # reading above reads (XERK-1625): `a=$(false || echo rm -rf / | grep
        # .); $a`. Its own pass, one per suffix reading, never joined to them.
        readings = _value_taint_readings(value)
        _VALUES_TAINT_N[0] = max(_VALUES_TAINT_N[0], len(readings))
        if _VALUES_TAINT[0] >= 0:
            if readings:
                produced = readings[min(_VALUES_TAINT[0], len(readings) - 1)]
            produced = produced.replace("\n", " ")
        elif _VALUES_MULTI[0]:
            produced = produced.replace("\n", " ")
        else:
            base = _produced_text(value, multi=False)
            _VALUES_DIFFER[0] |= produced != base
            produced = base
        vals.setdefault(m.group(1), []).append(produced)
        where.setdefault(m.group(1), []).append(m.start())
        if "${" in raw and not _MAIN_PARSE[0]:
            # Bash applies a `${y:-…}` default when it assigns, so `$x` runs
            # it; stored unapplied, `x=${y:-"rm -rf /"}; $x` spliced a word
            # nothing re-reads (XERK-1621). Added, never swapped: `y` may be
            # set after all — so kept out of `plain` below.
            for with_default in _default_readings(raw):
                if with_default != value:
                    applied.setdefault(m.group(1), []).append(
                        _produced_text(with_default, multi=_VALUES_MULTI[0]))
                    applied_where.setdefault(m.group(1), []).append(m.start())
    if "printf" in command and "-v" in command:
        for seg in _split_segments(command):
            bound = _printf_v(_strip_prefixes(_tokenize(seg)))
            if bound:
                vals.setdefault(bound[0], []).append(bound[1])
                where.setdefault(bound[0], []).append(None)
                if "${" in seg and not _MAIN_PARSE[0]:
                    # Its arguments' defaults applied too, as for `x=${y:-…}`:
                    # unapplied, `printf -v a %s "${x:-rm -rf /}"; $a` spliced
                    # the raw `${…}` text nothing re-reads (XERK-1659).
                    with_default = _printf_v(_strip_prefixes(_tokenize(_substitute_vars(seg, {}))))
                    if with_default and with_default != bound:
                        applied.setdefault(with_default[0], []).append(with_default[1])
                        applied_where.setdefault(with_default[0], []).append(None)
    bare = command.replace("'", "").replace('"', "").replace("\\", "")
    if "read" in bare or "select" in bare or "mapfile" in bare:
        # Gated on the text with quotes cut: `r''ead a` is `read a`.
        for name, value in _reader_values(command):
            vals.setdefault(name, []).append(value)
            where.setdefault(name, []).append(None)

    def bind(scripts: set[str], known: dict[str, list[str]]) -> None:
        """Bind the names each script assigns, its line's names spliced in
        too: `v=a; eval "$(echo "$v='rm …'")"` assigns `a` (XERK-1668)."""
        for script in list(scripts):
            if "$" in script:
                spliced = _var_sub(lambda u: _picked(known[u.group(1) or u.group(3)], u.group(1) or u.group(3))
                                   if (u.group(1) or u.group(3)) in known and not u.group(2)
                                   else u.group(0), script)
                _spend(len(spliced) - len(script))
                scripts.add(spliced)
        for sc in scripts:
            for name, got in _assigned_values(sc, depth + 1, known).items():
                # Each value once: two readings of one script binding
                # it twice halved the line's value headroom.
                have = vals.setdefault(name, [])
                new = [v for v in dict.fromkeys(got) if v not in have]
                have.extend(new)
                where.setdefault(name, []).extend([None] * len(new))

    lists = _for_lists(command)
    if depth < _EVAL_ASSIGN_DEPTH:
        # A `for` name holds its list's words: `for e in eval; do $e "a=…"`
        # runs that eval (XERK-1666). Read for this scan only, never into
        # ``vals``: a list's words are data, not counted values. Built once:
        # per segment it was segments × words, and a long line timed out.
        for_known: dict[str, list[str]] = {}
        for_split: dict[str, list[str]] = {}
        for name, _s, _e, raw_words, _shell in lists:
            for w in raw_words:
                if "$" in w and _unquoted_dollar(w):
                    # An unquoted expansion, glued quotes or not (`$x''`):
                    # bash splits it into fields. A name may be an outer
                    # loop's (`for y in 'ls eval'; do for e in $y`).
                    fields = _dequote_value(_pattern_vars(w, {**vals, **for_known})).split()
                    if len(fields) > 1:
                        have = for_split.setdefault(name, [])
                        # The first few, every piece of `eval` itself, and a
                        # few more holding it (trimmed: `xeval`), wherever they
                        # sit in a long list. Each costs a reading per use.
                        seen, more = set(have), 0
                        for k, f in enumerate(dict.fromkeys(fields)):
                            low = f.lower()
                            if f in seen:
                                continue
                            if k >= _MAX_VALUE_READINGS and low not in "eval":
                                if "eval" not in low or more >= _MAX_VALUE_READINGS:
                                    continue
                                more += 1
                            have.append(f)
                for_known.setdefault(name, []).append(_dequote_value(w))
        # An assignment `eval` runs binds the name for the rest of the line:
        # `eval "a=\$(echo rm -rf /)"; $a` runs it, though no `a=` starts a
        # word here (XERK-1651). Eval's words joined, as it re-parses them,
        # wherever an `eval` word sits (`f(){ eval …`, `command eval`), however
        # it is spelled (`e\val`), and with the names and output in them read.
        for seg in _split_segments(command):
            if "al" not in seg and "$" not in seg:
                continue
            # A `$"…"` locale string is a plain `"…"` here: tokenized, its `$`
            # stayed and `$p$"al"` read the name `al` (XERK-1666).
            words = _tokenize(_LOCALE_QUOTE_RE.sub("", seg))
            known = {**(env or {}), **vals}
            for name, got in for_known.items():
                known[name] = known.get(name, []) + got
            for k, w in enumerate(words):
                # ...or spelled by names: `x=eval; $x "a=…"`, `${x}al`, `${x,,}`.
                # A `${!x}` or `@E`/`@P`/`@a`… word may be eval however x's value is
                # built (`$'\x79'`, `${n%z}`, a loop name), which no reading
                # of it can follow: its words are read as eval's (XERK-1666).
                if _basename(w) != "eval" and not ("$" in w and (
                        _MAYBE_EVAL_RE.search(w) or _eval_named(w, known, for_split))):
                    continue
                rest = words[k + 1:]
                while rest and (_basename(rest[0]) == "eval" or rest[0] == "--"):
                    rest = rest[1:]
                scripts = {" ".join(rest)}
                # ...and what a `$(…)` handed to it prints, read off the raw
                # words: tokenized, its inner quotes were lost. Its taint
                # readings too, which read pipes and here-strings
                # (`eval "$(cat <<<"a='rm …'")"`, XERK-1668).
                for sub in _find_substs(seg) if "$(" in seg or "`" in seg else ():
                    inner = _subst_inner(sub)
                    scripts.update(filter(None, (_printed_text(inner),
                                                 *(_body_tainted(inner) or ()))))
                bind(scripts, known)
                break
        # `source <(…)` and `. /dev/stdin <<<…` run their text as a script in
        # THIS shell, binding its names as an `eval` does (XERK-1668).
        if "." in command or "source" in command:
            segs = _split_segments(command)
            stdin_readers: dict[int, object] = {}
            scripts = set()
            for k, seg in enumerate(segs):
                words = _tokenize(seg)
                # Wherever the reader sits (`f(){ source <(…)`), as for `eval`.
                # Its file a `<(…)` (a word `_tokenize` splits) or stdin.
                # `source -- FILE` takes its `--` as bash does.
                files = [words[j + 2] if words[j + 1] == "--" and j + 2 < len(words) else words[j + 1]
                         for j, w in enumerate(words[:-1]) if w in (".", "source")]
                if any(_STDIN_SCRIPT_RE.match(f.rstrip(";")) for f in files):
                    stdin_readers[k] = None
                if any(f.startswith("<(") for f in files):
                    scripts.update(t for sub in _find_substs(seg) if sub.group(0).startswith("<(")
                                   for t in _proc_subst_texts(_subst_inner(sub)))
            if stdin_readers:
                # Its stdin as a `read`'s is found: its own here-string, a
                # group's (`{ . /dev/stdin; } <<<…`), a `< <(…)` or a pipe.
                for feed in itertools.chain(*_reader_feeds(command, segs, stdin_readers).values()):
                    if feed.startswith("$(") and feed.endswith(")"):
                        scripts.update(_proc_subst_texts(feed[2:-1]))
                    else:
                        scripts.add(_dequote_value(feed))
            if scripts:
                bind(scripts, {**(env or {}), **vals})
    # How many values one name is ASSIGNED, so `_expand_both` reads each on
    # its own. Not a `for` list's words: those are a loop's data, and a long
    # list would cost a whole reading per word.
    # Applied defaults are read per value too. Assignments have their cap,
    # and all of a name's values a looser one (`_expand_picks`): a line of
    # nine `x=${D:-…}` is nine assignments, eighteen values.
    for k, got in vals.items():
        _VALUES_MOST[0] = max(_VALUES_MOST[0], len(got) + len(applied.get(k, ())))
        _VALUE_COUNTS[k] = max(_VALUE_COUNTS.get(k, 0), len(got) + len(applied.get(k, ())))
        _VALUES_ASSIGNED[0] = max(_VALUES_ASSIGNED[0], len(got))
    # A per-word reading (`_for_word_lines`): each picked loop's name holds
    # that word alone, as its iteration does. Any other binding joined in
    # made `v=a; for v in 'rm …'; do $v; done` run program `a`. A pick whose
    # list this text does not hold is no pick here.
    picks = {name: k for name, k in _FOR_PICK[0] or ()
             if sum(1 for f in lists if f[0] == name) > k}
    for name in picks:
        vals.pop(name, None)
        applied.pop(name, None)
        where.pop(name, None)
        applied_where.pop(name, None)
    seen_of: dict[str, int] = {}
    for name, _start, _end, raw_words, _shell in lists:
        nth = seen_of[name] = seen_of.get(name, -1) + 1
        if name in picks and nth != picks[name]:
            continue
        # Whole words, dequoted as bash binds them: split on blanks, `for v in
        # "$(echo rm -rf /)"` bound `"rm`, `-rf`, `/"` (XERK-1622).
        # A `${x:-…}` word is read with its default applied too, as an
        # assignment's is.
        words = []
        for raw_word in raw_words:
            words.append(_dequote_value(raw_word))
            if "${" in raw_word and not _MAIN_PARSE[0]:
                words.extend(_default_readings(raw_word))
        if words:
            vals.setdefault(name, []).extend(words)
            # A `for` list word has no one place: it is read once, order-blind.
            # Resolving a word that uses a line name (`for f in "$q$c"; do
            # a=$f`) in order would catch one more shape (XERK-1703), but it
            # multiplies the per-word loop readings and was 100s on a real
            # command with large lists (QA). Its name's value still travels
            # through the loop's BODY replay, which catches the common shapes.
            where.setdefault(name, []).extend([None] * len(words))
            _FOR_NAMES.add(name)
    # A value naming an assigned variable (`d=$d/x`, `a=$b; b=$a`) is resolved
    # HERE, once, against the values that name none. Left in, every recursion
    # level re-inlined it, the text grew each time, and an ordinary command
    # was refused as nested too deeply. An unresolvable one is empty, as bash
    # reads an unset name.
    if _PWD_UNASSIGNED[0]:
        # `cd` rewrites both, so the line's own assignment is not where a
        # later `$PWD` points: read as written, `_under_cwd` judges them
        # against every directory the line visited (XERK-1753).
        for table in (vals, applied, where, applied_where):
            for name in _CD_NAMES:
                table.pop(name, None)
    elif any(name in vals or name in applied for name in _CD_NAMES):
        _PWD_SEEN[0] = True
    plain = {k: [v for v in vs if not _names_assigned(v, vals)] for k, vs in vals.items()}
    own = {k: len(vs) for k, vs in vals.items()}
    # An applied default is one more value of its name, and resolves OTHER
    # names (`y=${x:-"rm …"}; z=$y; $z`), never its own: there it took
    # `x=; x=${x-a}"rm …"; $x` (the `${x-a}` empty, x set) to `arm …` in
    # every reading.
    for k, vs in applied.items():
        vals.setdefault(k, []).extend(vs)
        where.setdefault(k, []).extend(applied_where[k])
    others = {k: plain.get(k, []) + [v for v in vs if not _names_assigned(v, vals)]
              for k, vs in applied.items()}

    def resolve(m: "re.Match[str]", owner: str) -> str:
        name = m.group(1) or m.group(3) or ""
        if name not in vals:
            return m.group(0)
        value = _picked(plain[name] if name == owner else others.get(name, plain[name]), name)
        if _decoding_op(m.group(2)):
            # Decoded, or unreadable: `z=${y@E}; $z` (XERK-1666).
            value = _CASE_OPS[_decoding_op(m.group(2))](value)
        # Its trim too: `b=${a%% *}; "$b"` runs the first word (XERK-1651).
        op = _VAR_OP_RE.match(m.group(2) or "")
        if op and op.group(1) not in _VAR_DEFAULT_OPS:
            got = _op_readings(value, op.group(1), op.group(2), plain)
            value = got[0] if len(got) == 1 else " ".join((_UNREAD_OUTPUT, *got))
        _spend(len(value) - len(m.group(0)))
        return value

    once = {k: [_var_sub(lambda m, k=k: resolve(m, k), v, nested=True) for v in vs] for k, vs in vals.items()}
    # Resolved once, a chain read empty: `q=/etc; d=$q; r=$d` left `r` empty
    # and `rm -rf $r` passed (XERK-1648). The chain-resolved values are a
    # reading of their OWN (`_expand_both`), never mixed into these: appended,
    # they moved which value each per-value pass picks, so main's pairing of
    # two names' last values was lost (`a=$p; a=eval; b=x; b='rm …'; $a "$b"`);
    # swapped in, a later assignment was read into an earlier use whose empty
    # reading is bash's (`c=$p/; p=1`).
    chained = _chain_values(vals, applied, own)
    if chained != once:
        _CHAIN_DIFFERS[0] = True
    # And in ORDER, each value read against what is assigned before it
    # (XERK-1660): order-blind, `q=/etc; d=$q$c; c=x; rm -rf $d` read d as
    # `/etcx`, a value bash never sees. Added beside the order-blind
    # readings, never in place of them: a function body runs where it is
    # CALLED, not written (`f(){ x=$y; }; y=/etc; f`), which this does not
    # model and they read.
    # Read only when it holds a value neither of those has: one that only
    # drops values is already read value by value (`_expand_picks`), and
    # each reading is a whole-line expansion (2-12x on real loops, QA).
    ordered = _ordered_values(vals, where, chained, _loop_bodies(command), misparse)
    if ordered is not chained and any(v not in once[k] and v not in chained[k]
                                      for k, vs in ordered.items() for v in vs):
        _ORDER_DIFFERS[0] = True
        # A loop's later laps may add values: read each on its own too. Not a
        # `for` list's name: its words are data, never counted (see above).
        for k, got in ordered.items():
            if k not in _FOR_NAMES:
                _VALUE_COUNTS[k] = max(_VALUE_COUNTS.get(k, 0), len(got))
                _VALUES_MOST[0] = max(_VALUES_MOST[0], len(got))
    return (once, chained, ordered)[_VALUES_CHAINED[0]]


_ORDER_MISPARSE_RE = re.compile(r"[;\n<>]")


class _OrderUnread(Exception):
    """A value `_ordered_values` leaves to the order-blind readings."""


# How many times `_ordered_values` reads a loop's body at most: enough for a
# value to travel back through a few of its assignments (`z=$a; a=$m; m=/etc`).
_ORDER_LAPS = 8


def _ordered_values(vals: dict[str, list[str]], where: dict[str, list[int | None]],
                    base: dict[str, list[str]], loops: list[tuple[int, int, int]],
                    misparse: set[int]) -> dict[str, list[str]]:
    """``vals`` read in the order bash assigns them: each value is resolved
    against the values its names hold where it is assigned — a name not yet
    assigned there is empty, as unset. A value with no one place (``where``
    None) keeps its ``base`` reading and is a value of its name everywhere.

    A loop's body (``loops``) is read again, lap after lap until its values
    settle, as bash runs it again: `for …; do z=$a; a=/etc; done` gives z
    `/etc` from its second pass on. A later lap's different value is one more
    value of its name. On those laps a value naming its own name (`s=$s$f`)
    reads that name as it was entering the loop: as it is, the value grew
    every lap and never settled; skipped, `z=$z$a; a=/etc` never read `/etc`."""
    out = {k: list(vs) for k, vs in base.items()}
    fixed = {k: [base[k][i] for i, p in enumerate(where[k]) if p is None] for k in vals}
    grouped: dict[tuple[int, str], list[int]] = {}
    for k, ps in where.items():
        for i, p in enumerate(ps):
            if p is not None:
                grouped.setdefault((p, k), []).append(i)
    uses = {k: [_names_used(v) & vals.keys() for v in vs] for k, vs in vals.items()}
    # Order changes what a value reads only where a name it uses is assigned
    # AFTER it, or a loop runs it again; elsewhere the order-blind readings,
    # value by value, already read it (and this one would double the cost of
    # every line reassigning a name, QA). ``base`` itself then: not needed.
    last = {k: max((p for p in ps if p is not None), default=-1) for k, ps in where.items()}
    linked = [(p, n) for (p, k), idxs in grouped.items() for i in idxs for n in uses[k][i]]
    forward = any(last[n] > p for p, n in linked)
    if not forward and not any(b[0] <= p < b[1] for p, _n in linked for b in loops):
        return base
    current: dict[str, list[str]] = {}
    # Bounded on its own, never charged to the decision: every reading
    # recomputes these, and charged each time, a value doubling three times
    # (`y=$x$x; x=$y`, 2 KB) was too large (QA). Splicing them into a reading
    # is charged where it happens; this only bounds what is built here.
    growth = [0]
    # The value being read on a later lap, and the names as they entered its loop.
    owner: list = [None, {}]

    def link(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(3)
        if name not in vals:
            return m.group(0)
        held = owner[1] if name == owner[0] else current
        value = _picked(held.get(name, []) + fixed[name], name)
        if _decoding_op(m.group(2)):
            value = _CASE_OPS[_decoding_op(m.group(2))](value)  # as `resolve` (XERK-1666)
        op = _VAR_OP_RE.match(m.group(2) or "")
        if op and op.group(1) not in _VAR_DEFAULT_OPS:
            got = _op_readings(value, op.group(1), op.group(2),
                               {n: current.get(n, []) + fixed[n] for n in vals
                                if current.get(n) or fixed[n]})
            if len(got) != 1:
                # Unread: the order-blind readings already splice it, and in
                # order it reached program words they never did (QA).
                raise _OrderUnread
            value = got[0]
        growth[0] += max(0, len(value) - len(m.group(0)))
        if growth[0] > _MAX_SUBST_GROWTH:
            raise _ExpansionTooLarge
        return value

    extra: dict[tuple[str, int], str] = {}

    def read(events: list[tuple[int, str]], lap: int) -> None:
        for p, k in events:
            idxs = grouped[(p, k)]
            owner[0] = k if lap else None
            got = []
            for i in idxs:
                try:
                    # An over-captured value (``misparse``) is left order-blind.
                    if uses[k][i] and p in misparse:
                        raise _OrderUnread
                    got.append(_var_sub(link, vals[k][i], nested=True) if uses[k][i] else vals[k][i])
                except _OrderUnread:
                    got.append(base[k][i])
            for i, v in zip(idxs, got):
                if not lap:
                    out[k][i] = v
                elif v not in out[k]:
                    extra[(k, i)] = v
            current[k] = got

    # The events in order, a loop's together so its body can be read again.
    runs: list[tuple[bool, list[tuple[int, str]]]] = []
    for p, k in sorted(grouped):
        body = next((span for span in loops if span[0] <= p < span[1]), None)
        if runs and runs[-1][0] == body and body is not None:
            runs[-1][1].append((p, k))
        else:
            runs.append((body, [(p, k)]))
    for body, events in runs:
        owner[1] = {k: list(v) for k, v in current.items()}
        read(events, 0)
        for lap in range(1, min(len(events), body[2]) if body is not None else 1):
            before = {k: list(v) for k, v in current.items()}
            read(events, lap)
            if current == before:
                break
    if not forward and not extra:
        return base
    for (k, _i), v in extra.items():
        if v not in out[k]:
            out[k].append(v)
    return out


# A `do` or `done` keyword: a loop body's bounds (`_loop_bodies`). Only where
# a command starts: an argument (`echo done`, `x=done`) is a word, and read as
# a keyword it ended the body early (QA). The lookbehind char is judged on the
# EXPANSION-MASKED text (`_mask_expansions`): a `)`/`}`/`(` closing or opening
# `$(…)`, `${…}`, `$((…))` or an `=(…)` array is not a command boundary, so
# `echo ${q} done`, `$(true) done`, `x=(done)` keep the body open. A real
# `(subshell)` or `{ group; }` closer still is. `case …(pat)` stays a residual.
_DO_DONE_RE = re.compile(r"(?:^|(?<=[;&|\n(){}]))[ \t]*(do|done)(?![\w.-])")


@functools.lru_cache(maxsize=64)
def _mask_expansions(command: str) -> str:
    """``command`` with the interior AND delimiters of each quoted run, `$(…)`,
    backtick, `${…}` and `=(…)` array replaced by `.`, lengths preserved, so a
    scan sees only top-level structure."""
    masked = list(command)
    states = _quote_states(command)
    for i, st in enumerate(states):
        if st:
            masked[i] = "."
    for sub in _find_substs(command):
        for i in range(sub.start(), sub.end()):
            masked[i] = "."
    # `$((…))` arithmetic: `_find_substs` scans INTO it but does not return it,
    # so its `))` would read as a command closer (`$((1)) done`, QA). Masked by
    # a balanced-paren span from `$((`.
    for m in re.finditer(r"\$\(\(", command):
        if states[m.start()]:
            continue
        depth, i = 0, m.end() - 2
        while i < len(command):
            if command[i] == "(":
                depth += 1
            elif command[i] == ")":
                depth -= 1
                if not depth:
                    break
            i += 1
        for j in range(m.start(), min(i, len(command) - 1) + 1):
            masked[j] = "."
    for m in re.finditer(r"\$\{", command):
        if states[m.start()]:
            continue
        end = _brace_end(command, m.start())
        for i in range(m.start(), (end + 1 if end > 0 else len(command))):
            masked[i] = "."
    for m in re.finditer(r"(?<![<>])=\(", command):
        if states[m.start()]:
            continue
        depth, i = 0, m.end() - 1
        while i < len(command):
            if command[i] == "(":
                depth += 1
            elif command[i] == ")":
                depth -= 1
                if not depth:
                    break
            i += 1
        for j in range(m.start() + 1, min(i, len(command) - 1) + 1):
            masked[j] = "."
    return "".join(masked)


def _loop_bodies(command: str) -> list[tuple[int, int, int]]:
    """The span of each outermost `do … done` body in ``command``, bare
    keywords only (one in quotes is text), and how many times to read it: a
    `for` over N literal words runs it N times, so a value built a link per
    lap is not read deeper than bash builds it (`v=/w/$u/x; u=$v`, QA);
    anything else up to `_ORDER_LAPS`."""
    if "done" not in command:
        return []
    masked = _mask_expansions(command)
    lists = {end: words for _name, _start, end, words, shell in _for_lists(command) if shell}
    spans, depth, start, laps, nested = [], 0, 0, _ORDER_LAPS, False
    for m in _DO_DONE_RE.finditer(masked):
        if m.group(1) == "do":
            if not depth:
                start, laps, nested = m.end(), _ORDER_LAPS, False
                head = command[:m.start(1)].rstrip(" \t\n;")
                words = lists.get(len(head))
                if words and not any(re.search(r"[$`*?\[]", w) for w in words):
                    laps = min(len(words), _ORDER_LAPS)
            else:
                nested = True
            depth += 1
        elif depth:
            depth -= 1
            if not depth:
                spans.append((start, m.start(1), _ORDER_LAPS if nested else laps))
        if m.group(1) == "do":
            if not depth:
                start, laps, nested = m.end(), _ORDER_LAPS, False
                head = command[:m.start(1)].rstrip(" \t\n;")
                words = lists.get(len(head))
                if words and not any(re.search(r"[$`*?\[]", w) for w in words):
                    laps = min(len(words), _ORDER_LAPS)
            else:
                nested = True
            depth += 1
        elif depth:
            depth -= 1
            if not depth:
                spans.append((start, m.start(1), _ORDER_LAPS if nested else laps))
    return spans


def _chain_values(vals: dict[str, list[str]], applied: dict[str, list[str]],
                  own: dict[str, int]) -> dict[str, list[str]]:
    """``vals`` with every value naming an assigned name resolved through its
    whole chain, in dependency order (`_dependency_order`): each value is read
    once every name it uses outside its group has ALL its values."""
    known: dict[str, list[str]] = {k: [] for k in vals}
    defaults: dict[str, list[str]] = {k: [] for k in vals}
    waits: dict[str, set[str]] = {k: set() for k in vals}
    linked: dict[str, list[tuple[int, set[str]]]] = {}
    for k, vs in vals.items():
        for i, v in enumerate(vs):
            names = _names_used(v) & vals.keys()
            if names:
                waits[k] |= names
                linked.setdefault(k, []).append((i, names))
            else:
                (known if i < own[k] else defaults)[k].append(v)
    out = {k: list(vs) for k, vs in vals.items()}

    def link(m: "re.Match[str]", owner: str) -> str:
        name = m.group(1) or m.group(3)
        if name not in vals:
            return m.group(0)
        got = known[name] if name == owner or not defaults[name] else known[name] + defaults[name]
        value = _picked(got, name)
        if _decoding_op(m.group(2)):
            value = _CASE_OPS[_decoding_op(m.group(2))](value)  # as `resolve` (XERK-1666)
        op = _VAR_OP_RE.match(m.group(2) or "")
        if op and op.group(1) not in _VAR_DEFAULT_OPS:
            # Names in its pattern or alternative read from what is known so far.
            got = _op_readings(value, op.group(1), op.group(2),
                               {n: known[n] + defaults[n] for n in known if known[n] or defaults[n]})
            value = got[0] if len(got) == 1 else " ".join((_UNREAD_OUTPUT, *got))
        _spend(len(value) - len(m.group(0)))
        return value

    def settle(k: str, i: int) -> str:
        return _var_sub(lambda m: link(m, k), vals[k][i], nested=True)

    for group in _dependency_order(waits):
        # Each value is read ONCE, against what is known before its group:
        # every name a group uses outside it is resolved whole. Inside a
        # cycle (`a=$b; b=$a`, `d=/; d=$d/etc`) a member reads another's
        # unlinked values only, and an unknown member is empty, as an unset
        # name. What a cycle really holds depends on ORDER, which this
        # order-blind reading does not model (XERK-1660); every propagation
        # tried traded one shape for another — re-reading on each change
        # nested every lap's text until a test loop's `n=$((n + ${m:-0}))`
        # counters were refused as too deep, and reading in seed order let a
        # stuck read's value leak into members that never re-read it.
        for k, i, got in [(k, i, settle(k, i)) for k in group for i, _names in linked.get(k, ())]:
            out[k][i] = got
            (known if i < own[k] else defaults)[k].append(got)
    return out


def _names_used(text: str) -> set[str]:
    """Every name ``text`` expands, those in an operator's argument included
    (`${q:+$a}` uses `a`)."""
    names: set[str] = set()
    for m in _var_uses(text):
        names.add(m.group(1) or m.group(3))
        if m.group(2) and "$" in m.group(2):
            names |= _names_used(m.group(2))
    return names


def _dependency_order(waits: dict[str, set[str]]) -> list[set[str]]:
    """The names of ``waits`` (name → names its values use) in groups, each
    after every group it uses: Tarjan's strongly connected components, which
    come out dependencies first. A group of more than one name, or a name
    using itself, is a cycle. Iterative, so a long chain cannot overflow the
    stack."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    groups: list[set[str]] = []
    for root in waits:
        if root in index:
            continue
        index[root] = low[root] = len(index)
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(sorted(waits[root])))]
        while work:
            node, edges = work[-1]
            for nxt in edges:
                if nxt not in index:
                    index[nxt] = low[nxt] = len(index)
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, iter(sorted(waits[nxt]))))
                    break
                if nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
            else:
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])
                if low[node] == index[node]:
                    group = set()
                    while True:
                        name = stack.pop()
                        on_stack.discard(name)
                        group.add(name)
                        if name == node:
                            break
                    groups.append(group)
    return groups


def _value_taint_readings(value: str) -> tuple[str, ...]:
    """``value`` with each substitution `_body_tainted` reads replaced by its
    taint, one string per suffix reading (`_body_tainted_at`); empty when no
    substitution in it has a taint reading."""
    parts: list[str | tuple[str, ...]] = []
    last, n = 0, 0
    for m in _find_substs(value):
        parts.append(value[last:m.start()])
        taint = None
        if m.group(0)[0] in "$`" and not _subst_in_arith(m):
            taint = _body_tainted(_subst_inner(m))
        if taint is None:
            parts.append(_subst_text(m))
        else:
            parts.append(taint)
            n = max(n, len(taint))
        last = m.end()
    parts.append(value[last:])
    return tuple("".join(p if isinstance(p, str) else p[min(k, len(p) - 1)]
                         for p in parts) for k in range(n))


def _dequote_value(value: str) -> str:
    """An assignment value as bash stores it: quotes removed, their contents
    and any substitution kept verbatim (`'a b'c` → `a bc`)."""
    out: list[str] = []
    i, n = 0, len(value)
    while i < n:
        m = _ASSIGN_SUBST_RE.match(value, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            continue
        ch = value[i]
        m = re.compile(r"\$([A-Za-z_]\w*)(?=['\"])").match(value, i)
        if m:
            # A name a quote ends, braced: stored as `$btc`, `$b'tc'` read an
            # unset name where bash expands `$b` then appends `tc` (XERK-1661).
            out.append("${" + m.group(1) + "}")
            i = m.end()
            continue
        if ch == "$" and value.startswith("'", i + 1):
            # `$'…'` is its ANSI-C decoded text (XERK-1657 QA: `f(){ $1; };
            # f $'rm …'` bound `$rm …`).
            m = re.compile(r"\$'((?:[^'\\]|\\.)*)'", re.S).match(value, i)
            if m:
                try:
                    out.append(m.group(1).encode().decode("unicode_escape"))
                except (UnicodeDecodeError, UnicodeEncodeError):
                    out.append(m.group(1))
                i = m.end()
                continue
        if ch == "$" and value.startswith('"', i + 1):
            # `$"…"` is a locale string: the `"…"` with no `$` (XERK-1657).
            # Kept, `for v in a $"rm …"` bound `$rm …`, a name read empty.
            i += 1
            continue
        if ch == "'":
            j = value.find("'", i + 1)
            j = n if j < 0 else j
            out.append(value[i + 1:j])
            i = j + 1
        elif ch == '"':
            j = i + 1
            while j < n and value[j] != '"':
                m = _ASSIGN_SUBST_RE.match(value, j)
                if m:
                    out.append(m.group(0))
                    j = m.end()
                    continue
                m = re.compile(r"\$([A-Za-z_]\w*)(?=\")").match(value, j)
                if m:  # `"$b"tc`, as above
                    out.append("${" + m.group(1) + "}")
                    j = m.end()
                    continue
                if value[j] == "\\" and j + 1 < n:
                    j += 1
                out.append(value[j])
                j += 1
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _produced_text(value: str, multi: bool = True) -> str:
    """``value`` with each substitution replaced by what it prints.

    The substitution's own command is classified where it sits; the variable
    holds only its OUTPUT. Inlining the `$(…)` text instead re-classified it
    at every use, and a long line of `$x`s took minutes (XERK-1549) — past
    Claude Code's hook timeout, which lets the command through. Innermost
    first: `_subst_text` resolves `$(echo $(echo rm) …)` and nested backticks
    itself (XERK-1605). An escaped one is replaced too — the value may be
    re-parsed, and reading it as output only ever classifies more.
    """
    out: list[str] = []
    last = 0
    for m in _find_substs(value):
        out.append(value[last:m.start()])
        out.append(_subst_text(m, multi=multi))
        last = m.end()
    out.append(value[last:])
    return "".join(out)


def _printf_unescape(text: str) -> str:
    """The backslash escapes printf decodes: `\\n`, `\\x20`, `\\040`, …"""

    def rep(m: "re.Match[str]") -> str:
        esc = m.group(1)
        try:
            if esc[0] in "xu" and len(esc) > 1:
                return chr(int(esc[1:], 16))
            if esc[0].isdigit():
                return chr(int(esc, 8) & 0xFF)
        except ValueError:
            return m.group(0)
        return _PRINTF_ESCAPES.get(esc, m.group(0))

    return _PRINTF_ESC_RE.sub(rep, text)


def _render_printf(fmt: str, args: list[str]) -> str:
    """Roughly what `printf FMT ARGS…` prints: each conversion takes the next
    argument (and a `*` width/precision one more), the format repeats while
    arguments remain, as bash's does. Only the TEXT matters here, so width is
    ignored and every conversion prints its argument as `%s` would."""
    fmt = _printf_unescape(fmt)
    out: list[str] = []
    rest = list(args)

    def take() -> str:
        return rest.pop(0) if rest else ""

    def conv(m: "re.Match[str]") -> str:
        if m.group(1) == "%":
            return "%"
        if m.group(2) == "*":
            take()
        prec = m.group(3)
        if prec == "*":
            prec = take()
        arg = take()
        kind = m.group(4)
        if kind == "b":
            arg = _printf_unescape(arg)
        elif kind == "c":
            arg = arg[:1]
        elif kind in "qQ":
            # Quoted for re-reading, as `eval "$(printf 'a=%q' 'rm …')"` does
            # (XERK-1668): printed bare, the eval bound `a=rm` and ran `-rf`.
            arg = shlex.quote(arg)
        if prec is not None and kind in "sb":
            try:
                arg = arg[:max(int(prec or 0), 0)]
            except ValueError:
                pass
        if m.group(2) and m.group(2).isdigit():
            # Padding is text too: `rm%1s-rf` with an empty argument is `rm -rf`.
            width = min(int(m.group(2)), _PRINTF_MAX_WIDTH)
            arg = arg.ljust(width) if "-" in m.group(1) else arg.rjust(width)
        return arg

    for _ in range(64):  # bounded: a format with no conversion consumes nothing
        before = len(rest)
        out.append(_PRINTF_SPEC_RE.sub(conv, fmt))
        if not rest or len(rest) == before:
            break
    else:
        # Out of passes with arguments left: bash would print every one, and
        # dropping them hid `/etc` as the ninth (XERK-1549). Keep them as text.
        out.append(" " + " ".join(rest))
    return "".join(out).split(_PRINTF_STOP, 1)[0]


def _printf_args(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Split a `printf …` argv into its `-v` name (or None) and FORMAT ARGS."""
    name, i = None, 1
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            i += 1
            break
        if tok == "-v" and i + 1 < len(tokens):
            name, i = tokens[i + 1], i + 2
        elif tok.startswith("-v") and len(tok) > 2:
            name, i = tok[2:], i + 1
        else:
            break
    return name, tokens[i:]


def _printf_v(tokens: list[str]) -> tuple[str, str] | None:
    """`printf -v NAME FORMAT [ARGS…]` assigns what printf would have printed,
    so `printf -v x 'rm -rf /'; $x` runs it (XERK-1549)."""
    if not tokens or _basename(tokens[0]) != "printf":
        return None
    name, rest = _printf_args(tokens)
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?$", name or "")
    if not m or not rest:
        return None  # `a[0]` is `$a` too
    return m.group(1), _render_printf(rest[0], rest[1:])


# `read`'s options that take a value; `-a`'s value is the NAME it fills.
_READ_OPTS_WITH_VALUE = set("adinNptu")
_HERESTRING_RE = re.compile(r"<<<[ \t]*")


# `select v in …` reads the chosen line into REPLY; `v` is its list's.
_SELECT_RE = re.compile(r"[\s!{(]*(?:(?:do|then|else|elif|if|while|until)\s+)*select\s")
# `mapfile`/`readarray`'s options that take a value; `-t` is a flag there.
_MAPFILE_OPTS_WITH_VALUE = set("dnOsuCc")


def _herestring(seg: str) -> tuple[str, str] | None:
    """The `<<< WORD` in ``seg``: its word, and ``seg`` with the word cut out."""
    m = _HERESTRING_RE.search(seg)
    if m and ("'" in seg or '"' in seg or "\\" in seg):
        # Only an unquoted one: `read -p '<<<' a` has none of its own.
        states = _quote_states(seg)
        m = next((h for h in _HERESTRING_RE.finditer(seg) if not states[h.start()]), None)
    if not m:
        return None
    end = _word_end(seg, m.end())
    end = end if end >= 0 else len(seg)
    return seg[m.end():end], seg[:m.end()] + seg[end:]


def _reader_names(tokens: list[str]) -> tuple[list[str], list[str]] | None:
    """The scalar names and array names a `read` or `mapfile`/`readarray`
    fills from its stdin, or None if ``tokens`` is neither."""
    got = _reader_opts(tokens)
    return got[:2] if got else None


def _reader_opts(tokens: list[str]) -> tuple[list[str], list[str], dict[str, str]] | None:
    """`_reader_names`, with the value of each option given one (`-d`, `-C`,
    `-u`), dequoted (XERK-1658)."""
    if not tokens:
        return None
    prog = tokens[0]
    if prog == "read":
        opts = _READ_OPTS_WITH_VALUE
    elif prog in ("mapfile", "readarray"):
        opts = _MAPFILE_OPTS_WITH_VALUE
    else:
        return None
    names, arrays, i = [], [], 1
    values: dict[str, str] = {}
    while i < len(tokens):
        tok = tokens[i]
        if "<" in tok or ">" in tok:
            # A redirection, maybe glued to the name before it (`a<<<"…"`);
            # a detached operator takes the next word with it (the `<<<`
            # word is already cut out).
            glued = re.match(r"([A-Za-z_][A-Za-z0-9_]*)[<>&]", tok)
            if glued:
                names.append(glued.group(1))
            # ...with its descriptor too: `read a 0< f` (XERK-1658 QA).
            i += 2 if re.fullmatch(r"[0-9]*(?:<|>|>>|<<|<&|>&)", tok) else 1
            continue
        if tok.startswith("-") and len(tok) > 1 and tok != "--":
            # A cluster's first option taking a value takes the rest of it, or
            # the next word: `-ra arr`, but `-ar arr` fills the array `r`.
            at = next((c for c, ch in enumerate(tok[1:], 1) if ch in opts), 0)
            value = tok[at + 1:] if at else ""
            if at and not value and i + 1 < len(tokens):
                i += 1
                value = tokens[i]
            if at:
                values[tok[at]] = _dequote_value(value)
            if prog == "read" and at and tok[at] == "a":
                # Its name, maybe glued to the redirection (`-a arr<<<"…"`).
                arrays.append(re.match(r"[^<>&]*", value).group(0))
        elif re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", tok):
            names.append(tok)
        i += 1
    names = [n for n in names if _ASSIGN_NAME_RE.fullmatch(n)]
    arrays = [n for n in arrays if _ASSIGN_NAME_RE.fullmatch(n)]
    if prog != "read":
        # mapfile's one name is an array, MAPFILE when none is given.
        return [], (names[:1] or ["MAPFILE"]), values
    if not names and not arrays:
        names = ["REPLY"]
    return names, arrays, values


_GROUP_OPENERS = {"while", "until", "if", "for", "select", "case"}
_GROUP_CLOSERS = {"done", "fi", "esac"}
_FUNC_HEADER_RE = re.compile(r"^(?:function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*")


def _seg_groups(segs: list[str]) -> list[tuple[int, int]]:
    """The `(opener, closer)` segment indexes of each `{ … }`, `( … )` and
    loop/`if`/`case` on a split line, so a reader is fed only through its own
    groups (XERK-1650). Approximate on purpose: an unclosed group runs to the
    end, and a stray closer closes nothing."""
    stack: list[int] = []
    groups: list[tuple[int, int]] = []
    for k, seg in enumerate(segs):
        t = seg.strip()
        while True:
            t = re.sub(r"^(?:!|do|then|else|elif)\s+", "", t)
            t = _FUNC_HEADER_RE.sub("", t)
            if t[:1] in ("{", "("):
                stack.append(k)
                t = t[1:].lstrip()
                continue
            if t.split(" ", 1)[0] in _GROUP_OPENERS:
                stack.append(k)
            break
        in_case = any(segs[o].lstrip(" !({").startswith("case") for o in stack)
        closes = 0
        while t[:1] in ("}", ")") or t.split(" ", 1)[0] in _GROUP_CLOSERS:
            closes += 1
            t = t[1:].lstrip() if t[:1] in ("}", ")") else t.split(" ", 1)[-1] \
                if " " in t else ""
        if not in_case:
            closes += max(0, t.count(")") - t.count("("))
        for _ in range(closes):
            if stack:
                groups.append((stack.pop(), k))
    groups.extend((o, len(segs) - 1) for o in stack)
    return groups


def _reader_feeds(command: str, segs: list[str], readers: dict[int, object],
                  blind: frozenset[int] = frozenset()) -> dict[int, list[str]]:
    """What each reader (by segment index) may get as its stdin from elsewhere
    on the line (XERK-1650): a here-string or `< <(…)` on a
    group it is in (`{ read a; } <<< …`, `while read …; done < <(…)`), or a
    PIPED `echo`/`printf` (or a group of them) into it or one of its groups.
    A feed on any other command — `cat <<< … |`, `f <<< …` calling a reader
    function, `exec < <(…)`, an echo piped into `cat` — is unaccounted for,
    so it feeds EVERY reader. Paired, not every feed to every reader: a line
    of N `echo … | while read` loops read each name N ways (N² readings).
    A ``blind`` reader reads a file or descriptor (`read a < f`, `read -u
    ${COPROC[0]}`) whatever wrote it, so every echo on the line feeds it.
    A `yes WORDS` prints its words, and a program spelled by an expansion
    (`$(echo echo) WORDS`) may be an echo, so both are read as one (XERK-1658)."""
    own: list[list[str]] = []
    echo: list[str | None] = []
    piped: list[bool] = []
    pos = 0
    for seg in segs:
        feeds = []
        here = _herestring(seg)
        if here:
            feeds.append(here[0])
        if "<(" in seg:
            feeds.extend("$" + m.group(0)[1:] for m in _find_substs(seg)
                         if m.group(0).startswith("<("))
        own.append(feeds)
        at = command.find(seg, pos)
        if at >= 0:
            pos = at + len(seg)
        # A segment the split rewrote can't be placed, so it counts as piped.
        piped.append(at < 0 or bool(re.match(r"[\s)]*\|(?!\|)", command[pos:])))
        tokens = _strip_prefixes(_tokenize(seg.lstrip("({ \t")))
        start = seg.index(tokens[0]) if tokens and tokens[0] in seg else \
            len(seg) - len(seg.lstrip("({ \t")) if tokens else -1
        # The program word as written: `'echo'` tokenizes without its quote.
        while start > 0 and seg[start - 1] in "'\"\\":
            start -= 1
        # Its output is the file's, which a blind reader reads anyway.
        printed = _OUT_REDIRECT_RE.sub(" ", seg[start:]) if start >= 0 else ""
        prog = _basename(tokens[0]) if tokens else ""
        spelled = bool(tokens) and start >= 0 and seg[start] in "$`\"'" \
            and not tokens[0][:1].isalpha()
        if start >= 0 and tokens[0] in _ECHO_PROGS and seg.startswith(tokens[0] + " ", start):
            echo.append("$(" + printed.rstrip(") \t") + ")")
        elif start >= 0 and (prog in _ECHO_PROGS or prog == "yes" or spelled):
            # `/bin/echo`, `'echo'`, `yes`, or a program an expansion spells
            # (`$(echo echo)`, `` `echo echo` ``): its words, past the whole
            # program word (`$(echo echo)` tokenizes in two).
            end = _word_end(printed, 0)
            seg = printed
            words = seg[end:].strip().rstrip(") \t") if end > 0 else ""
            # A group's closer is no word: `( read a; $a ) < f`.
            words = re.split(r"(?:^|\s)[)}](?:\s|$)", words, maxsplit=1)[0].strip()
            if prog == "yes" and words.startswith("--"):
                words = words[2:].strip()
            # A bare `$a` uses a value, it prints none: read as `echo` with
            # no words it bound a reader to "" (XERK-1658 QA).
            echo.append("$(echo " + words + ")" if words else None)
        else:
            echo.append(None)
    groups = _seg_groups(segs)
    closers = {c for _, c in groups}
    openers = {o for o, _ in groups}
    orphans: list[str] = []
    for k in range(len(segs)):
        if k not in readers and k not in closers:
            orphans.extend(own[k])
        if echo[k] and piped[k] and k + 1 < len(segs) \
                and k + 1 not in readers and k + 1 not in openers:
            orphans.append(echo[k])

    def into(o: int) -> list[str]:
        """What is piped into segment ``o``: an echo, or a group's echoes."""
        if o == 0 or not piped[o - 1]:
            return []
        lo = min([g for g, c in groups if c == o - 1], default=o - 1)
        return [e for e in echo[lo:o] if e]

    # A reader in a group redirected from a file (`done < f`, `} < f`), or
    # on a line whose stdin `exec < f` moves, is blind too.
    blind = set(blind)
    if any(re.match(r"\s*exec\b[^|;&]*?" + _FILE_INPUT_RE.pattern, sg) for sg in segs):
        blind.update(readers)
    for o, c in groups:
        if _FILE_INPUT_RE.search(_HERESTRING_RE.sub(" ", segs[c].lstrip("}) \t"))):
            blind.update(k for k in readers if o <= k <= c)
    out = {}
    for k in readers:
        feeds = own[k] + into(k) + ([e for e in echo if e] if k in blind else [])
        for o, c in groups:
            if o <= k <= c:
                feeds += own[c] + into(o)
        out[k] = list(dict.fromkeys(feeds + orphans))
    return out


def _reader_values(command: str) -> list[tuple[str, str]]:
    """The `(name, value)`s the line's readers bind: `read [opts] NAME… <<<
    WORD` (XERK-1622), and a `read`, `mapfile`/`readarray` or `select` fed
    by a group's or loop's here-string, a `< <(…)` or a pipe
    (XERK-1650, `_reader_feeds`). Split as bash does under the default IFS —
    each name a word, the last the remainder — or, when the line sets IFS or
    for an array, every name the whole text. Each line of a multi-line text
    is read on its own too, as `while read` and `mapfile` take it. A WORD
    with a `${…}` default is read with it applied too. A literal IFS the line
    sets, or a reader's `-d`, also cuts the text into pieces, each bound to
    every name (XERK-1658): `IFS=, read a b <<< "x,rm …"` binds `b`."""
    segs = _split_segments(command)
    whole = "IFS" in command
    ifs = _split_chars(m.group(1) for m in _IFS_ASSIGN_RE.finditer(command))
    readers: dict[int, tuple[list[str], list[str]]] = {}
    seps: dict[int, str] = {}
    blind: set[int] = set()
    for k, seg in enumerate(segs):
        if _SELECT_RE.match(seg):
            # `_strip_prefixes` drops `select v in` as a compound's head.
            readers[k] = (["REPLY"], [])
            continue
        here = _herestring(seg)
        text = here[1] if here else seg
        # A redirection may lead the command: `<<< w read a`.
        text = re.sub(r"\A\s*[0-9]{0,4}<<<\s*", "", text)
        if "<(" in text:
            # Its words are no names: `read a < <(echo rm …)` bound `rm`.
            for m in reversed(_find_substs(text)):
                text = text[:m.start()] + "/dev/fd/63" + text[m.end():]
        # A function's body opens on its header: `f(){ read a`.
        text = _FUNC_HEADER_RE.sub("", text.lstrip())
        got = _reader_opts(_strip_prefixes(_tokenize(text)))
        if got:
            readers[k] = got[:2]
            # `-d ''` delimits on NUL.
            seps[k] = ifs + (_split_chars([got[2]["d"]]) or "\0" if "d" in got[2] else "")
            if "u" in got[2] or _FILE_INPUT_RE.search(text):
                blind.add(k)
    if not readers:
        return []
    feeds = _reader_feeds(command, segs, readers, frozenset(blind))
    out: list[tuple[str, str]] = []
    for k, got in readers.items():
        here = _herestring(segs[k])
        # Its own here-string is what it reads (or a `< <(…)` after it, the
        # last redirection winning); the rest is a group's stdin.
        words = feeds[k]
        if here and not _SELECT_RE.match(segs[k]):
            words = [here[0]] + [f for f in feeds[k]
                                 if f.startswith("$(") and "<(" + f[2:] in segs[k]]
        for word in words:
            out.extend(_bind_read(*got, word, whole, seps.get(k, ifs)))
    return list(dict.fromkeys(out))


def _reader_extra_readings(line: str, commands: str, heredocs: list[tuple[str, str, bool]],
                           vals: dict[str, list[str]]) -> list[str]:
    """Texts the line also runs as, for what a reader binds that `_reader_values`
    cannot see from the heredoc-stripped ``commands`` (XERK-1658):
    - a heredoc fed to a reader (`read a <<E` / body / `E`; `$a`) is read as
      the here-string of its body, which `_reader_values` binds;
    - `mapfile -C f` calls `f INDEX LINE` per line: read as those calls
      written after it, so `f() { $2; }` binds `$2` to each line.
    ADDED readings, each re-expanded whole: the main pass still reads the
    bodies. Neither holds what made it, so the re-expansion stops there."""
    out = []
    # Only a heredoc's own rewrite needs the segment scan; without one it is
    # the `mapfile -C` callbacks below that run, so skip it (a 30 KB line
    # with no heredoc paid `_HEREDOC_OP_RE.sub` over it for nothing, QA pass 16).
    reader_segs = [seg for seg in _split_segments(commands) if _reader_opts(_strip_prefixes(
        _tokenize(_FUNC_HEADER_RE.sub("", _HEREDOC_OP_RE.sub(" ", seg).lstrip()))))] \
        if heredocs else []
    # Each operator where the LEXER found it, never by searching the text:
    # a quoted or commented copy of an owner line, a `$((1<<2))` shift or a
    # `$'\''` took the rewrite, the real `<<E` left to swallow the reading.
    # Owners are per occurrence (identical lines are two), grouped by number.
    # ...or a reader word in COMMAND position the splitter left inside one
    # segment (`x=$(read a`, `"$(while read l`). Never a word anywhere: a
    # body bound for "read" in a title cost seconds and denied as data, and
    # binding it inert hid real commands (QA passes 7-12). A reader the
    # splitter misses after a `$'\''` is that splitter's gap (XERK-1733).
    reader_word = _READER_WORD_RE
    trace: dict = {}
    has_word = any(w in commands for w in ("read", "mapfile", "readarray"))
    if heredocs and (reader_segs or (has_word and reader_word.search(commands))):
        _split_heredocs(line, trace)
    kept: list[str] = trace.get("kept", [])
    groups: dict[int, list[list]] = {}
    for op in trace.get("ops", []):
        groups.setdefault(op[1], []).append(op)
    # A reader of a file or descriptor (`read a < f`, `done < f`, `read -u 3`)
    # may read what a heredoc wrote there (`cat > f <<E`, `exec 3<<E`): the
    # file read is matched to the one written by name.
    read_paths = {_path_key(m.group(1), vals) for m in _READ_PATH_RE.finditer(commands)} \
        if groups else set()
    fd_read = any(re.search(r"-u|<&", seg) for seg in reader_segs)
    written: list[str] = []
    # Each operator's text in the readings: a reader's `<<E` as a here-string,
    # every other `<<E` cut — kept, it took the rest of the reading (the
    # echoes printed beside included) as its body.
    full: dict[int, str] = {}
    last: dict[int, str] = {}
    owner_of = {k: heredocs[k][0] for k in range(len(heredocs))}
    k = 0
    for number in sorted(groups):
        ops = groups[number]
        owner = owner_of.get(k, "")
        k += len(ops)
        texts = [op[2] if op[3] else _produced_text(op[2]) for op in ops]
        # A heredoc reaches a reader on its own command or group (the
        # heredoc may sit on a loop's `done` or lead: `<<E read a`). Never
        # one on another command: fed to every reader, a script's bodies
        # bound names that read a pipe and spent the budget (QA).
        # Judged on the command holding the `<<` (and its pipeline), never
        # the whole line: a `read -p` before `; gh … <<'EOF'` is not its reader.
        own = _heredoc_command(owner)
        own_states = _quote_states(own)
        reaches = any(seg.strip() and seg.strip() in own for seg in reader_segs) \
            or (has_word and any(not own_states[m.end() - 1]
                                 for m in reader_word.finditer(own))) or any(
                re.match(r"\s*(?:done\b|[})])", seg) for seg in _split_segments(own))
        if not reaches:
            # Only the command holding the `<<` (and its pipeline): a write
            # elsewhere on the line matched a reader's file (QA pass 8).
            wrote = _written_paths(own, vals)
            if (fd_read and re.search(r"\bexec\b", owner)) or read_paths and wrote and (
                    read_paths & wrote or "?" in read_paths or "?" in wrote):
                written.extend(texts)
            for op in ops:
                full[op[0]] = last[op[0]] = " "
            continue
        # As written, so a command in it runs wherever the value is run
        # (`eval "$a"` of `echo "$(rm …)"`, QA pass 9).
        strings = ["<<< " + _ansi_c_quote(t) for t in texts]
        for j, (op, h) in enumerate(zip(ops, strings)):
            full[op[0]] = h
            # `read a <<A <<B` reads B, the last: also read with only it.
            last[op[0]] = h if j == len(ops) - 1 else " "

    def placed(repl: dict[int, str]) -> str:
        return "".join(repl.get(j, piece) for j, piece in enumerate(kept))
    rewritten = last_only = commands
    if written or any(t != " " for t in full.values()):
        rewritten = placed(full)
        if last != full:
            last_only = placed(last)
    if written:
        # Printed beside, unpiped, so only a blind reader takes it; ONE
        # text of their lines, each line once, as N values (one a body)
        # spent the budget, and a file written N times over N copies.
        lines = dict.fromkeys(ln for body in written for ln in body.split("\n") if ln.strip())
        rewritten += "\necho " + shlex.quote("\n".join(lines))
    if rewritten != commands:
        out.append(rewritten)
    if last_only != commands:
        out.append(last_only)
    calls = []
    if "-C" in commands:
        for seg in _split_segments(rewritten):
            got = _reader_opts(_strip_prefixes(_tokenize(_FUNC_HEADER_RE.sub("", seg.lstrip()))))
            if not got or not got[2].get("C") or not got[1]:
                continue
            got_vals = vals if rewritten == commands else _var_values(rewritten)
            # A callback a name holds (`-C $g`) is each of its values.
            callback = got[2]["C"]
            named = re.fullmatch(r"\$\{?([A-Za-z_]\w*)\}?", callback)
            for cb in got_vals.get(named.group(1), []) if named else [callback]:
                for text in got_vals.get(got[1][0], []):
                    for k, ln in enumerate(ln for ln in text.split("\n") if ln.strip()):
                        calls.append(f"{cb} {k} {shlex.quote(ln)}")
    calls = list(dict.fromkeys(calls))
    if calls and not commands.endswith("\n".join(calls)):
        out.append(rewritten + "\n" + "\n".join(calls))
    return out


# A path a command reads: `< f`, `0< f`, `done < f`, `exec 3< f`; never
# `<<`, `<<<`, `< <(…)` or `<&N`.
_READ_PATH_RE = re.compile(r"(?<!<)[0-9]{0,4}<(?![<&]|\s*\()[ \t]*([^\s;|&<>()]+)")
_WRITE_PATH_RE = re.compile(r"(?<![<>])(?:&>>?|[0-9]{0,4}>[>|]?)(?!&)[ \t]*([^\s;|&<>()]+)")


def _path_key(word: str, vals: dict[str, list[str]]) -> str:
    """A path word as compared across a line: its file NAME, as `cd`s, `~`
    and `$S/` directories make one file many spellings; "?" when an
    expansion or glob spells the name. Over-matches on purpose: a `"?"` for
    every `$S/f` re-fed each body to each reader and spent the budget."""
    path = _dequote_value(word)
    if path == "/dev/null":
        return path
    name = os.path.basename(os.path.normpath(path))
    if "$" in name or "`" in name:
        name = _dequote_value(_substitute_vars(name, vals)) if vals else name
    return "?" if re.search(r"[$`*?\[]", name) else name


def _written_paths(owner: str, vals: dict[str, list[str]]) -> set[str]:
    """The files ``owner`` writes: its `>`/`>>`/`&>`/`>|` targets, `tee`'s
    and `dd of=`'s."""
    paths = {_path_key(m.group(1), vals) for m in _WRITE_PATH_RE.finditer(owner)}
    for seg in _split_segments(owner):
        words = _strip_prefixes(_tokenize(_HEREDOC_OP_RE.sub(" ", seg)))
        if words and _basename(words[0]) == "tee":
            paths.update(_path_key(w, vals) for w in words[1:] if not w.startswith("-"))
        if words and _basename(words[0]) == "dd":
            paths.update(_path_key(w[3:], vals) for w in words[1:] if w.startswith("of="))
    paths.discard("/dev/null")
    return paths


def _ansi_c_quote(text: str) -> str:
    """``text`` as one `$'…'` word."""
    return "$'" + text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"


def _heredoc_command(owner: str) -> str:
    """The `;`/`&&`/`||` pieces of ``owner`` holding a `<<`, cut only where
    those operators are unquoted: a quote-blind cut split `read -d ';'`,
    `IFS=';' read` and `read -p 'go; '` from their own heredoc (QA pass 13).
    A reader word must be unquoted there too, so "while read" in a title
    binds no body (seconds per call, then "too large")."""
    states = _quote_states(owner)
    pieces, start, i, n = [], 0, 0, len(owner)
    while i < n:
        if not states[i] and (owner[i] == ";" or owner.startswith(("&&", "||"), i)):
            pieces.append(owner[start:i])
            i += 1 if owner[i] == ";" else 2
            start = i
            continue
        i += 1
    pieces.append(owner[start:])
    return " ; ".join(p for p in pieces if "<<" in p)


# A reader in command position: after an operator, a group or substitution
# opener, a keyword or a prefix word, any assignments before it, maybe
# escaped (`\read`).
_READER_WORD_RE = re.compile(
    r"(?:\A|[;|&({`\n]|\$\(|(?<![\w-])(?:do|then|else|elif|while|until|if|!|time|command"
    r"|builtin|exec|nice|env|sudo|nohup))[ \t]*"
    # Assignment values read with their quotes: `IFS=';' read` (QA pass 14).
    # Each value unit has a distinct first char, and the catch-all excludes
    # `` ` ``, `$`, `(`, `)` so a run of them is tokenized ONE way — an
    # overlapping catch-all made `X=`x` `×20 backtrack exponentially and hang
    # the guard open (QA pass 16).
    # At most a few prefix assignments (`IFS=x LC_ALL=y read`): bounded so a
    # long run of `a=\`x\`` before a reader word is O(n), not a quadratic
    # finditer that holds the GIL past the hook deadline (QA pass 17).
    r"(?:[A-Za-z_]\w*=(?:\$'(?:[^'\\]|\\.)*'|'[^']*'|\"[^\"]*\"|\$\([^)]*\)"
    # The value's units are bounded too, or a long bare `` `x` ``-run as ONE
    # value backtracked O(n) per start — a new quadratic finditer main lacks
    # (QA pass 18). A real reader-prefix value is short.
    r"|`[^`]*`|[^\s;|&'\"$()`]){0,64}[ \t]+){0,8}"
    r"\\?(?:read|mapfile|readarray)(?![\w-])")
# A heredoc operator and its delimiter word: `<<E`, `<<-'E'`, `<< "E"`.
_HEREDOC_OP_RE = re.compile(r"(?<!<)<<-?[ \t]*(?:'[^']*'|\"[^\"]*\"|\\?[^\s;|&<>()'\"]+)(?!<)")


# An output redirection on an echo: `> f`, `2>>f`, `>&2`.
_OUT_REDIRECT_RE = re.compile(r"[0-9]{0,4}>>?&?[ \t]*[^\s;|&<>()]+")


def _split_chars(words) -> str:
    """The characters IFS/`-d` values ``words`` split on: each one's own, or
    every punctuation character for one an expansion spells (`IFS=$i`)."""
    out = ""
    for word in words:
        value = _dequote_value(word)
        # Not a path's or option's own characters: split on, they cut the
        # very command a piece would hold.
        out += re.sub(r"[/._~-]", "", string.punctuation) + "\t" \
            if "$" in value or "`" in value else value
    return "".join(dict.fromkeys(out))


# The most (name, piece) bindings a split adds before only the joined value
# is read: covers a 5-field pad (25) and an 8-name read (64), not a wide CSV.
_MAX_SPLIT_PAIRS = 64
# `IFS=<word>` (or `IFS=$'…'`) that a later reader splits on (XERK-1658).
_IFS_ASSIGN_RE = re.compile(r"(?<![\w$])IFS=(\$?'[^']*'|\"[^\"]*\"|\$\{[^}]*\}|[^\s;|&)'\"]+)")
# A reader's stdin redirected from a file or descriptor, not a here-string,
# heredoc or `<(…)` (XERK-1658: `read a < /tmp/f`).
_FILE_INPUT_RE = re.compile(r"(?<!<)<(?!<|\s*\()")


def _bind_read(names: list[str], arrays: list[str], word: str,
               whole: bool, seps: str = "", literal: bool = False) -> list[tuple[str, str]]:
    """``word`` bound to a reader's names; ``literal`` = ``word`` is the text
    itself (a quoted heredoc body), not shell text to dequote."""
    texts = [word if literal else _dequote_value(word)]
    if "${" in word and not _MAIN_PARSE[0] and not literal:
        texts.extend(_default_readings(word))
    out = []
    for text in dict.fromkeys(texts):
        produced = text if literal else _produced_text(text, multi=_VALUES_MULTI[0])
        # Blanks beside another separator split no piece of their own:
        # `IFS=', '` hands the last name the whole `rm -rf /`. Alone they do.
        cut = re.sub(r"[ \t]", "", seps) or seps
        if cut:
            # Over-reads on purpose: which piece a name gets depends on its
            # place, so every name gets every piece. A few pieces each on its
            # own too, so `rm -rf "$d"` sees one path (QA pass 12); always as
            # ONE value of a piece per line, which a use reads as commands —
            # a value per piece alone was too many readings for a long text.
            pieces = list(dict.fromkeys(
                p for p in re.split("[" + re.escape(cut) + "\n]", produced) if p.strip()))
            split = "\n".join(pieces)
            if split and split != produced:
                out.extend((n, split) for n in names + arrays)
                names_arrays = names + arrays
                # Every piece to EVERY name: which field a name gets is
                # bash's split, blanks/escapes/lines and all — modelling it
                # bound the wrong field and ran a quoted `rm -rf "$b"` (QA
                # pass 15). Over-read, but bounded by a pair budget: a
                # 16-name × 16-field CSV read is 256 bindings, which tripped
                # "too large" (pass 14). Past it, only the joined value — the
                # same reading a 17+-field split already gets.
                if len(pieces) * len(names_arrays) <= _MAX_SPLIT_PAIRS:
                    out.extend((n, p) for p in pieces for n in names_arrays)
        lines = [ln for ln in produced.split("\n") if ln.strip()]
        # Each line is its own read (`while read`, `mapfile`): one value with
        # the lines kept, which a use splits into commands, not a value per
        # line — N reads of an N-line text was N² readings (XERK-1650).
        readings = [[" ".join(lines)]] + ([lines] if len(lines) > 1 else [])
        for got in readings:
            text = "\n".join(got)
            out.extend((n, text) for n in arrays)
            if whole or len(names) == 1:
                out.extend((n, text) for n in names)
            elif names:
                split = [ln.split() for ln in got]
                out.extend((n, "\n".join(w[k] if k < len(w) else "" for w in split))
                           for k, n in enumerate(names[:-1]))
                out.append((names[-1], "\n".join(" ".join(w[len(names) - 1:])
                                                  for w in split)))
    return out


def _names_assigned(value: str, vals: dict[str, list[str]]) -> bool:
    return any((m.group(1) or m.group(3)) in vals for m in _var_uses(value))


@functools.lru_cache(maxsize=16)
def _closers(command: str, reading: tuple[bool, bool]) -> dict[int, int]:
    """Per command line (and `'` reading): where each opener `_brace_end` has
    scanned closes."""
    return {}


def _brace_end(command: str, i: int, quoted: bool | None = None) -> int:
    """Index of the `}` closing the `${` at ``i``, or -1 if it never closes.

    Quotes, `$(…)`, backticks and nested `${…}` inside the braces hide a `}`,
    as they do from bash: `${a:-'}'}` and `${a:-$(echo })}` are one expansion.
    In a `${…}` inside `"…"` (``quoted``; looked up when not given) a nested
    `"…"` quotes, and a `'` pairs unless `_BRACE_OTHER_SHELL` (XERK-1621).

    Where an opener closes depends only on the text after it, so every opener
    the scan passes is remembered per command line and skipped on the next
    scan. Without that, each of N unclosed `${a:-$(` ran to the end of the
    line: O(N × length), minutes for a 40 KB command, and a hook that times
    out lets the command run unchecked (XERK-1596).
    """
    memo = _closers(command, (_BRACE_OTHER_SHELL[0], _MAIN_PARSE[0]))
    if i in memo:
        return memo[i]
    if _MAIN_PARSE[0]:
        quoted = False
    elif quoted is None:
        quoted = _quote_states(command)[i] == '"'
    stack = [('{"' if quoted else "{", i)]
    j, n = i + 2, len(command)
    if _bad_brace(command, i) and _BRACE_OTHER_SHELL[0]:
        j = _dash_bad_body(command, i)

    def opened(kind: str) -> int:
        """Push the opener at ``j``; a remembered one is skipped instead.
        Returns where the scan resumes, or -1 once the outer one can't close."""
        end = memo.get(j)
        if end is None and kind == "{" and _bad_brace(command, j) \
                and _BRACE_OTHER_SHELL[0]:
            # As above: dash skips its name and operator character.
            stack.append(('{"' if stack[-1][0] in ('"', '{"') else "{", j))
            return _dash_bad_body(command, j)
        if end is None:
            if kind == "{" and stack[-1][0] in ('"', '{"') and not _MAIN_PARSE[0]:
                kind = '{"'
            stack.append((kind, j))
            return j + (1 if kind in ('"', "`") else 2)
        return end + 1 if end >= 0 else -1

    while j < n:
        ch = command[j]
        top = stack[-1][0]
        if ch == "\\":
            j += 2
            continue
        if top == "`" or top == '"':
            if ch == top:
                memo[stack.pop()[1]] = j
                if not stack:
                    return j
                j += 1
            elif top == '"' and command.startswith(("${", "$("), j):
                j = opened(command[j + 1])
            elif top == '"' and ch == "`":
                j = opened("`")
            else:
                j += 1
            if j < 0:
                break
            continue
        if top == '{"' and ch == "'":
            _BRACE_OTHER_SEEN[0] = True
            if _BRACE_OTHER_SHELL[0]:
                j += 1
                continue
        if ch == "'" or command.startswith("$'", j):
            ansi = ch == "$"
            j += 2 if ansi else 1
            while j < n and command[j] != "'":
                j += 2 if ansi and command[j] == "\\" else 1
            j += 1
            continue
        if command.startswith(("${", "$("), j):
            j = opened(command[j + 1])
        elif ch in ('"', "`"):
            j = opened(ch)
        elif (ch == "}" and top in ("{", '{"')) or (ch == ")" and top == "("):
            memo[stack.pop()[1]] = j
            if not stack:
                return j
            j += 1
        else:
            j += 1
        if j < 0:
            break
    for _, start in stack:
        memo[start] = -1
    return -1


def _live_dollar(command: str, i: int) -> bool:
    """Whether the `$` at ``i`` starts an expansion: not escaped, and not the
    second half of a `$$`. A run of `$` pairs into PIDs from its first LIVE
    one, and an odd run of backslashes before the run makes its first `$`
    literal — so `\\$${x}` expands `${x}` while `$${x}` and `\\${x}` do not."""
    j = i
    while j > 0 and command[j - 1] == "$":
        j -= 1
    k = j
    while k > 0 and command[k - 1] == "\\":
        k -= 1
    live = i - j + 1 - (j - k) % 2
    return live % 2 == 1


# A bare name glued to another expansion: `$x$(…)`, `$x${y}`, `` $x`…` ``,
# `\$x\$(…)`. Even after a `$`: `\$$x` is a literal `$` then a live `$x`, and
# skipping it let `eval \$$x$(echo 'y rm …')` through (XERK-1615 QA); `$$x`
# braced as `$${x}` is still the PID, then text.
_GLUED_NAME_RE = re.compile(r"\$([A-Za-z_]\w*)(?=[$`\\])")
# A bare name a quote ends: `$b'tc'`, `"$b"tc`, `$(echo $b'tc')`.
_QUOTE_ENDED_NAME_RE = re.compile(r"\$([A-Za-z_]\w*)(?=['\"])")


def _brace_glued_names(text: str) -> str:
    """``text`` with each bare `$name` glued to another expansion braced,
    `${name}`, which bash reads the same. Inlined first, the expansion after
    it extended the name: `$x$(echo rm …)` read as `$xrm …`, an unset name
    that swallowed the command bash runs when x is unset (XERK-1615 QA).

    Quoted or escaped ones too: the inliner splices into single-quoted and
    escaped text a `-c` script re-parses (`bash -c '$x$(echo rm …)'`), and
    in text nothing re-parses the rewrite changes only data.

    The brace is right only where the name and the expansion re-parse at the
    same level, which the text alone cannot say: `eval \\$x$(echo 'y rm …')`
    runs `$xy rm …`. So `_expand` also reads the text unbraced."""
    if "$" not in text or not _BRACE_GLUED[0]:
        return text
    return _brace_quote_ended(_GLUED_NAME_RE.sub(r"${\1}", text))


def _brace_quote_ended(text: str) -> str:
    """``text`` with each live `$name` a quote ends braced: inlined as
    `$btc`, `$(echo $b'tc')` read an unset name where bash appends `tc` to
    `$b` (XERK-1661). Unlike a glued expansion the brace is right at any
    re-parse level, so `_expand` takes no unbraced reading for it — that
    second reading doubled the cost of ~9% of real commands (QA). Two
    exceptions, left as written: an escaped `\\$b'…'` (an `eval` joins it
    into `$b…`), and a `$b'` inside `'…'`, whose `'` closes the outer quote
    so a `-c` re-parse reads `$b` joined to the text after it."""
    if "'" not in text and '"' not in text or not _QUOTE_ENDED_NAME_RE.search(text):
        return text
    states = _quote_states(text)

    def brace(m: "re.Match[str]") -> str:
        i = m.start()
        if states[i] == "\\" or not _live_dollar(text, i) \
                or states[i] == "'" and text[m.end()] == "'":
            return m.group(0)
        return "${" + m.group(1) + "}"
    return _QUOTE_ENDED_NAME_RE.sub(brace, text)


# Off while `_expand` takes its unbraced reading (see `_brace_glued_names`).
_BRACE_GLUED = [True]
# On while `_expand_readings` takes the reading where a brace word starts at
# the quote-aware word start (`_expand_braces`); SEEN once the two differ.
_BRACE_QUOTED = [False]
_BRACE_QUOTED_SEEN = [False]


@_budgeted
def _substitute_vars(command: str, vals: dict[str, list[str]] | None = None) -> str:
    """Inline variables the command line sets itself.

    Only names this very command assigns are substituted — an unresolved
    `$TMPDIR` is left alone rather than guessed at. ``vals`` supplies them
    from an enclosing command line instead (a group body sees its parent's).
    """
    # NB: no early return on an empty map — `${nope:-/etc}` needs no assignment.
    command = _brace_glued_names(command)
    if vals is None:
        vals = _var_values(command)
    if "${!" in command and vals:
        # `${!a}` is the variable a's value names: `a=b; eval "${!a}"` runs
        # $b (XERK-1634). A value that is no name is left as written.
        def indirect(m: "re.Match[str]") -> str:
            target = _picked(vals.get(m.group(1)) or [""], m.group(1))
            return "${" + target + "}" if _ASSIGN_NAME_RE.fullmatch(target) else m.group(0)
        command = _INDIRECT_RE.sub(indirect, command)

    states = _quote_states(command) if (vals and "$" in command) or "${" in command else []

    def default(text: str, at: int) -> str:
        """A `${x:-…}` default at ``at``, spliced as the text bash reads."""
        # Spliced bare, `${y:- #}; rm -rf /` became `echo  #; rm -rf /` and
        # the `rm` a comment. The `#` was a word inside the braces; keep it
        # one (XERK-1585). Quotes and `$(…)` in the default stay live.
        out = re.sub(r"(?<!\\)#", r"\\#", text)
        # A bare name in it braced, so text after the `}` stays text:
        # `${a#${b:-$nope}x}` read the pattern as `$nopex` (XERK-1651).
        out = re.sub(r"(?<!\\)\$([A-Za-z_]\w*)", r"${\1}", out)
        if states and states[at] == '"':
            out = _dq_default(out)
            # In `"…"` bash drops the `\` before a `}` in a default; kept,
            # `"${a#"${b:-\}}"}"` read the pattern as a literal `\}`
            # and never trimmed (XERK-1659 QA).
            out = _dq_unescape_brace(out)
        return out

    def rep(m: "re.Match[str]", depth: int) -> tuple[str, int]:
        """What the use ``m`` splices, and where the text after it resumes."""
        if not _SPLICE_RAW[0] and not _live_dollar(command, m.start()):
            # `\${a:-\"}` is literal text to bash, and `$${` is the PID then a
            # brace. Splicing either's "default" shifted the quoting under the
            # rest of the line: `echo "\${a:-\"}"; rm -rf /` hid the `rm`
            # inside a string that had closed (XERK-1585). Which `$` is live is
            # right for ONE parse only — an unquoted heredoc or `bash -c "…"`
            # strips a backslash level first — so `_expand_both` also takes the
            # splice-everything reading.
            _SPLICES_ESCAPED[0] += 1
            return m.group(0), m.end()
        rest, end = m.group(2) or "", m.end()
        # What the splice replaces: the inner uses already charged their own growth.
        replaced = end - m.start()
        if m.group(1):
            close = _brace_end(command, m.start(), states[m.start()] == '"')
            if close != end - 1:
                if close < end or vals.get(m.group(1)) \
                        and command.startswith("[", m.start() + 2 + len(m.group(1))):
                    # An assigned array's element is read as all its values
                    # joined, so its op read past a quoted `}` lost the
                    # default: raw, its `${` keeps an outer op unread, as
                    # before XERK-1659 (XERK-1700 tracks reading elements).
                    return m.group(0), end
                if "${" not in command[m.start() + 2:close]:
                    # `[^}]*` stopped at a `}` that is quoted — in
                    # `${a:-'}' #}` the expansion runs on to the last `}`.
                    # Splicing the short match left the `#` bare, a comment
                    # hiding the rest of the line (XERK-1585). Left raw,
                    # `eval "${a#\}}"` ran what the guard never read
                    # (XERK-1659): the operator reads up to the real `}`.
                    rest = command[m.start() + 2 + len(m.group(1)):close]
                    end = close + 1
                    replaced = end - m.start()
                else:
                    # A nested `${…}` closed first: `${x:-${y:-$(echo …)}}`. Left
                    # raw, `$a` read the whole line's text as one word and a
                    # default inside a default ran unseen (XERK-1653). The inner
                    # ones resolve first, then this one over what they spliced.
                    if depth >= _MAX_NESTED_VARS:
                        raise _ExpansionTooLarge
                    rest = sub(m.start() + 2 + len(m.group(1)), close, depth + 1)
                    end = close + 1
                    replaced = 3 + len(m.group(1)) + len(rest)
        name = m.group(1) or m.group(3) or ""
        got = vals.get(name)
        op = _VAR_OP_RE.match(rest)
        if not got and not op and rest.startswith("["):
            # An unset array's element takes its default as a scalar does:
            # `${y[0]:-rm -rf /}` runs it (XERK-1659).
            sub_end = rest.find("]")
            op = _VAR_OP_RE.match(rest[sub_end + 1:]) if sub_end > 0 else None
        if got and op and op.group(1) in (":-", ":=") and not _picked(got, name) \
                and not rest.startswith("["):
            # A name assigned empty takes its `:-`/`:=` default as an unset one
            # does: read as the empty value, `x=; ${x:-rm -rf /}` ran unseen
            # (XERK-1659).
            got = None
        if op and not got and op.group(1) in _VAR_DEFAULT_OPS and "$" in op.group(2) \
                and end == m.end():
            # A bare name in an unset name's default resolves as one nested in
            # braces does: spliced raw, `a=/etc; rm -rf ${q:-$a}` read the
            # path as `${a}`, a name nothing expanded again (XERK-1661). Only
            # the default's own span: an element's `[0]` stays as written.
            if depth >= _MAX_NESTED_VARS:
                raise _ExpansionTooLarge
            lead = len(rest) - len(op.group(2))
            rest = rest[:lead] + sub(m.start(2) + lead, end - 1, depth + 1)
            op = _VAR_OP_RE.match(rest[rest.find("]") + 1:] if rest.startswith("[") else rest)
            replaced = 3 + len(name) + len(rest)
        elem_op = None
        # Not inside another op: the marker in its pattern would hide its trim.
        if got and depth == 0 and rest.startswith("[") and rest.find("]") > 0:
            elem_op = _VAR_OP_RE.match(rest[rest.find("]") + 1:])
        if got and elem_op and elem_op.group(1) in _VAR_DEFAULT_OPS:
            # An assigned array's element may be empty or unset all the same
            # (`y=()`, `y=(a); ${y[1]:-…}`), which the joined values can't
            # say: read as the values AND as the default, led by the unread
            # marker. The values alone, `y=(); ${y[0]:-rm -rf /}` ran unseen
            # (XERK-1659).
            state = states[m.start()] if m.start() < len(states) else ""
            sep = '" "' if state == '"' else " "
            arg = elem_op.group(2)
            if "$" in arg and end == m.end():
                # Names in it resolve as an unset name's default does (XERK-1661 QA).
                if depth >= _MAX_NESTED_VARS:
                    raise _ExpansionTooLarge
                arg = sub(end - 1 - len(arg), end - 1, depth + 1)
                replaced += len(arg) - len(elem_op.group(2))  # `sub` charged it
            out = sep.join((_quote_literal(_UNREAD_OUTPUT, state),
                            _quote_literal(_picked(got, name), state),
                            default(arg, m.start())))
        elif got and _decoding_op(rest):
            # Decoded (`@E`) or unreadable (`@P`, marker-led): raw, a stored
            # `z=${y@E}` kept `\x65val` and `$z` ran eval (XERK-1666). Case
            # ops stay unapplied here: `${x^^}` on a case-blind disk is x.
            value = _CASE_OPS[_decoding_op(rest)](_picked(got, name))
            state = states[m.start()] if m.start() < len(states) else ""
            marked = value.startswith(_UNREAD_OUTPUT + " ")
            out = _splice_readings([value[len(_UNREAD_OUTPUT) + 1:]] * 2 if marked else [value],
                                   state)
        elif got:
            value = _picked(got, name)
            state = states[m.start()] if m.start() < len(states) else ""
            if state == '"' and (rest.startswith("[")
                                 or name in _FOR_NAMES and len(got) > 1
                                 and command[m.start() - 1:m.start()] == '"'
                                 and command[end:end + 1] == '"'):
                # `"${a[@]}"` is one word PER element, even mid-word: close
                # the quote around them, as bash's expansion does. So is any
                # subscript, read as every element: the values are joined, so
                # `a=(x /etc); rm -rf "${a[1]}"` read `"x /etc"` (XERK-1626).
                # A one-word list (a per-word reading) is a plain quoted
                # splice: bare, `for v in 'rm …'; do bash -c "$v"` handed
                # `-c` the word `rm` (XERK-1657).
                out = '"' + _quote_literal(value, "") + '"'
            else:
                # A name in an op's pattern is expanded first: `"${a%%$s*}"`.
                arg = op.group(2) if op else ""
                if state == '"' and op and op.group(1) in (":+", "+"):
                    arg = _dq_unescape_brace(arg)  # as a default's, below
                if not op and value.startswith(_UNREAD_OUTPUT + " "):
                    # A value bound from several readings (`y=${q%x$nope}`,
                    # `c="${a#${b:-x}}"`, `_assigned_values`), stored
                    # marker-led and joined: spliced as a direct op's readings
                    # are (XERK-1668, XERK-1673). One quoted word, `rm -rf
                    # "$c"` hid `/etc`. One reading (a `$(…)` output, `L=$(cat
                    # f || echo ls)`) is doubled, as `@E` does: alone it lost
                    # its marker and the program read as known.
                    readings = value.split(" ")[1:]
                    out = _splice_readings(readings * (2 if len(readings) == 1 else 1), state)
                else:
                    out = _splice_readings(_op_readings(value, op.group(1), arg, vals)
                                           if op else [value], state)
        elif name == "HOME" and op and op.group(1) in _VAR_DEFAULT_OPS and _HOME_KEPT[0]:
            # The reading where HOME is set, as it is in every shell an agent
            # runs: spliced, `"${HOME:-/tmp}"/*` read `/tmp/*` and hid the
            # home wipe (XERK-1656). Kept, `_home_readings` judges it.
            return "${" + name + rest + "}", end
        elif (name == "HOME" and rest and not (op and op.group(1) in _VAR_DEFAULT_OPS)
              and not re.search(r"[$`]", _HOME_USE_RE.sub("", rest))
              and not ("$" in rest and re.search(r"['\"]", rest))
              and (homes := _home_readings("${HOME" + rest + "}"))):
            # HOME is set where an agent runs, so its op reads the session's
            # HOME: kept as written, `${HOME:+r}m -rf /` hid the program and
            # `rm ${HOME:+-rf} /` the flag (XERK-1686). A reading inside the
            # home comes back as `$HOME…`, which the home rules judge; the
            # unset-HOME reading is the unset-names one, as for any name.
            # Only an op word with no other expansion: `_home_expanded` reads
            # `$((…))`/`$(…)` empty, so `${HOME:$((0)):0}` read `$HOME` (QA).
            # Nor a quoted `$HOME` in it: the quotes stay, so `"/root"/x`
            # never mapped back and `${HOME:+"$HOME"/x}` cleanups denied (QA).
            # Several (an extglob op, XERK-1664) splice as an op's readings
            # do: one alone dropped the text glued after it (`${HOME##@(*)}/etc`).
            # A reading back inside the home is braced: bare, glued text made
            # it another name (`${HOME%q}x/../x` read `$HOMEx/../x`, `/x`).
            state = states[m.start()] if m.start() < len(states) else ""
            out = _splice_readings([re.sub(r"\A\$HOME(?![A-Za-z0-9_])", "${HOME}", h)
                                    for h in homes], state)
        elif op and op.group(1) in _VAR_DEFAULT_OPS:
            out = default(op.group(2), m.start())
        else:
            return command[m.start():end], end
        _spend(len(out) - replaced)
        return out, end

    def sub(lo: int, hi: int, depth: int) -> str:
        """``command[lo:hi]`` with its uses spliced; positions stay the
        whole line's, so quoting and brace ends are read where they are."""
        out, last = [], lo
        k = max(command.rfind("}", lo, hi) + 1, lo)
        # As `_var_uses`: no `${…}` match past the range's last `}` (XERK-1596).
        for m in itertools.chain(_VAR_USE_RE.finditer(command, lo, k),
                                 _VAR_BARE_RE.finditer(command, k, hi)):
            if m.start() < last:
                continue  # inside a nested use already spliced
            text, end = rep(m, depth)
            out += (command[last:m.start()], text)
            last = end
        out.append(command[last:hi])
        return "".join(out)

    return sub(0, len(command), 0)


def _dq_unescape_brace(text: str) -> str:
    r"""A `${x:-…}` default or `:+` word inside `"…"` with each `\}` read as
    bash reads it there, a plain `}`. Kept, `"${a#"${b:-\}}"}"` read the
    pattern as a literal `\}` and never trimmed (XERK-1659)."""
    if "\\}" not in text:
        return text
    return re.sub(r"\\(.)", lambda e: "}" if e.group(1) == "}" else e.group(0), text, flags=re.S)


def _dq_default(text: str) -> str:
    """A `${x:-…}` default inside `"…"`, as text spliced into that string.

    There a `"…"` in the default is a string nested in the string, so
    spliced as written `"${y:-"it's"}"` became `""it's""`, its `'` an open
    quote hiding the rest of the line (XERK-1621). Its own `"` delimiters are
    dropped; an escaped one, and any inside a substitution or a nested
    `${…}`, stay as written."""
    if '"' not in text or _MAIN_PARSE[0]:
        return text
    spans = {m.start(): m.end() for m in _find_substs(text)}
    out, i, n = [], 0, len(text)
    while i < n:
        end = spans.get(i)
        if end is None and text.startswith("${", i):
            close = _brace_end(text, i, True)
            end = close + 1 if close >= 0 else None
        if end is not None:
            out.append(text[i:end])
            i = end
        elif text[i] == "\\":
            out.append(text[i:i + 2])
            i += 2
        else:
            if text[i] != '"':
                out.append(text[i])
            i += 1
    return "".join(out)


def _reading() -> tuple:
    """The reading flags a body's resolution reads, as a memo key: a body
    memoised under one reading was replayed under another (XERK-1621)."""
    return (_SPLICE_RAW[0], _BRACE_OTHER_SHELL[0], _MAIN_PARSE[0], _VALUE_PICK[0],
            _HOME_KEPT[0], _READINGS_JOINED[0], _BRACE_QUOTED[0], _PRINTED_DROP[0],
            _READING_PICK[0], _PWD_UNASSIGNED[0])


# Names a `for NAME in …` sets this decision. Its words are joined as the
# name's values, so a quoted `"$p"` read `for p in a /etc` as ONE word
# `a /etc`: a whole `"$p"` word splices each as a word of its own (XERK-1626
# QA); mid-string (`bash -c "rm -rf $p"`) they stay joined, a script's text.
_FOR_NAMES: set[str] = set()
# Set while `_expand_both` takes its raw reading; counts escaping splices.
_SPLICE_RAW = [False]
_SPLICES_ESCAPED = [0]
# Set while `_expand_both` reads assigned values as several statements print
# them; and whether any value this decision read differs that way (XERK-1609).
_VALUES_MULTI = [False]
_VALUES_DIFFER = [False]
# Which taint reading of the assigned values `_expand_both` is on (-1: none),
# and how many readings the values of this decision have (XERK-1625).
_VALUES_TAINT = [-1]
_VALUES_TAINT_N = [0]
# Set while `_expand_both` reads assigned values resolved through their whole
# chain; and whether any name of this decision reads differently so (XERK-1648).
# 0 when not; 2 when the values are read in order instead (XERK-1660), and
# whether any name reads differently so.
_VALUES_CHAINED = [0]
_CHAIN_DIFFERS = [False]
_ORDER_DIFFERS = [False]
# Set while `_expand_both` reads each of a name's values on its own: which one.
# And the most values this decision saw one name assigned (XERK-1621).
_VALUE_PICK: list = [None]
# Set while `_expand_both` reads one word of a `for` list (`_for_word_lines`):
# each picked loop's name and which of that name's `for` lists it is.
_FOR_PICK: list[tuple[tuple[str, int], ...] | None] = [None]
# How many values each name was assigned, for the cross passes (XERK-1634).
_VALUE_COUNTS: dict[str, int] = {}
_VALUES_MOST = [1]
_VALUES_ASSIGNED = [1]
# Set while `_expand_both` reads a `'` in a string's `${…}` as zsh and dash do,
# as a plain character; bash pairs it. And whether this decision saw one.
_BRACE_OTHER_SHELL = [False]
_BRACE_OTHER_SEEN = [False]
# Set while `_expand_both` splices an op's several readings inside `"…"` as
# ONE word (`_splice_readings`), and whether this decision spliced any.
_READINGS_JOINED = [False]
_READINGS_SEEN = [False]
# Set while `_expand_both` reads a lone `\` ending a substitution's printed
# text as dropped (`_subst_text`, XERK-1691); and whether this decision
# printed one. Never in place: kept, it joins a `\`-newline continuation and
# keeps an outer printer's escape run odd, which main's denies rely on.
_PRINTED_DROP = [False]
_PRINTED_DROP_SEEN = [False]
# Set while `_expand_both` reads the line with quoting parsed flat, as before
# XERK-1621 (no `${…}` frames, parens paired blind); and whether this decision
# saw text the two parsers read differently. Every new rule above is a model
# of some shell, and a malformed `${` each shell recovers from its own way,
# so the old parse's denies are KEPT as a reading rather than replaced.
_MAIN_PARSE = [False]
_MAIN_PARSE_SEEN = [False]
# Set while `_expand_both` reads a `${HOME:-w}` default as unused (XERK-1656):
# HOME is set where an agent runs, but `local HOME`, `read HOME` or `exec -c`
# can unset it, so the default spliced is kept as a reading of its own.
_HOME_KEPT = [False]
# Set while `_expand_both` reads PWD/OLDPWD as unassigned on a line that also
# moves (XERK-1753): `cd` rewrites both, so `PWD=/x; cd /etc; rm -rf $PWD`
# removes /etc, which only the unspliced `$PWD` (`_under_cwd`) reads. The
# assigned reading stays: `cd -` goes to the OLDPWD the line set.
_PWD_UNASSIGNED = [False]
_CD_NAMES = ("PWD", "OLDPWD")
_MOVES_RE = re.compile(r"(?<![\w-])(?:cd|pushd|popd)(?![\w-])")
# Whether any values pass of this decision bound PWD or OLDPWD, however the
# line spelled the name (`$'P\x57D'`, `P{W,}D`, `eval "${x}D=…"`): a text
# gate missed each spelling in turn, and a broad one cost +50% (XERK-1753 QA).
_PWD_SEEN = [False]
# Set while `_expand_both` reads the line with each multi-reading expansion
# spliced as its Nth reading (`_splice_readings`); and the most readings one
# expansion of this decision had (XERK-1664).
_READING_PICK: list = [None]
_READINGS_MOST = [0]
_MAX_READING_PICKS = 8
_HOME_DEFAULT_RE = re.compile(r"\$\{HOME:?[-=]")
# `$HOME` / `${HOME}` in an op word: the one name `_home_expanded` reads.
_HOME_USE_RE = re.compile(r"\$HOME(?!\w)|\$\{HOME\}")
# `cd` and `find` are left out: a `cd` matters only to a later target, whose
# command is listed, and a `find -delete` is read as an `rm -r` entry.
_HOME_TARGET_PROGS = {"rm", "unlink", "chmod", "chown", "chgrp"}
# Past this many `${…}` nested in one another, a line is too large to read.
_MAX_NESTED_VARS = 200
# Past this many assignments to one name, a line is too large to read.
_MAX_VALUE_READINGS = 16
# ...and past this many values of one name, applied defaults included.
_MAX_VALUE_PASSES = 24


def _picked(got: list[str], name: str = "") -> str:
    """A name's values as one reading splices them: all of them joined, as
    before XERK-1621, or the one `_expand_both` is on. Joined alone,
    `x=a; x="rm -rf /"; $x` ran `a rm -rf /` — the program `a`. On a cross
    pass (a tuple of (name, index) pairs) each name takes its own index."""
    k = _VALUE_PICK[0]
    if len(got) <= 1:
        return got[0] if got else ""
    if k is None:
        return " ".join(got)
    if isinstance(k, tuple):
        k = dict(k).get(name, len(got) - 1)
    return got[min(k, len(got) - 1)]


def _quote_literal(value: str, state: str) -> str:
    """``value`` spliced where quoting is ``state``, its quote characters kept
    LITERAL — bash never re-reads quotes an expansion produced. Spliced raw,
    `x='"'; echo "$x"; rm -rf /` unbalanced the line and hid the `rm`
    (XERK-1549). Inside `'…'` (a script some shell will expand later) the
    value's `'` closes, escapes and reopens. `$` stays live, so a `$(…)` a
    value carries is still classified where it lands.

    Each escape is right for ONE re-parse depth only — a value an `eval` of an
    `eval` reads is code again (`x=';'; eval 'eval echo $x rm -rf /'`). So when
    any value needed escaping, `_expand_both` also classifies the line with
    every value spliced RAW and denies if either reading does."""
    if _SPLICE_RAW[0]:
        return value
    escaped = _escape_value(value, state)
    if escaped != value:
        _SPLICES_ESCAPED[0] += 1
    return escaped


def _escape_value(value: str, state: str) -> str:
    if state == "'":
        # The script `eval`/`bash -c`/`trap` will parse, where the expansion
        # is a WORD — never a quote, comment or operator (`x='<<'` opened a
        # heredoc): escaped for THAT parse, then `'` closed and reopened here.
        inner = re.sub(r"([\\\"'`#<>;&|()])", r"\\\1", value)
        return inner.replace("'", "'\\''")
    # Bare: `;`/`|`/`&` stay live, since `eval $x` re-parses them as operators.
    bare = re.sub(r"([\\\"'`#<>])", r"\\\1", value)
    if state == '"':
        return re.sub(r'([\\"`])', r"\\\1", value)
    return bare


def _ifs_split_re(vals: dict[str, list[str]]) -> "re.Pattern[str] | None":
    """The non-blank characters of every IFS ``vals`` assigns, where an
    unquoted expansion splits, or None when it assigns none (XERK-1662)."""
    chars = {c for v in vals.get("IFS", ()) for c in v if not c.isspace()}
    return re.compile("[" + re.escape("".join(sorted(chars))) + "]") if chars else None


def _ifs_split_values(vals: dict[str, list[str]]) -> dict[str, list[str]]:
    """``vals`` with each `_ifs_split_re` character read as a blank, or {}:
    `IFS=,` makes `$x` of `rm,-rf,/etc` three words (XERK-1662). Every IFS
    value at once, and quoted expansions too: both only widen."""
    split = _ifs_split_re(vals)
    if split is None:
        return {}
    return {name: [split.sub(" ", v) for v in vs] for name, vs in vals.items() if name != "IFS"}


def _prenormalise(command: str) -> str:
    # Braced before ANSI-C decoding, which glued `$x$'eval'` into `$xeval`.
    command = _brace_glued_names(command)
    return _substitute_vars(_expand_braces(_IFS_RE.sub(" ", _decode_ansi_c(command))))


# `cmd <<EOF` / `<<-'EOF'` — everything up to the delimiter line is DATA fed to
# `cmd`, not commands. Newline is a segment separator, so without this every
# line of a heredoc body gets classified as a command of its own: a commit
# message documenting `DROP TABLE`, or any prose containing `rm -rf`, was
# refused. The body is still checked, but attributed to the command it feeds.


def _heredoc_word(command: str, j: int) -> tuple[str, bool, int]:
    """The delimiter word starting at ``j``: (delimiter, quoted, end index).

    Bash strips the quoting from the WHOLE word, and ANY quoting makes the body
    literal: `<<E"OF"` ends at `EOF`, `<<\\EOF` is quoted. Reading only an
    identifier ended `<<E"OF"` at a line `E` that never came, so every later
    line was swallowed as data.
    """
    n = len(command)
    word: list[str] = []
    quoted = False
    while j < n and command[j] not in _WORD_END:
        ch = command[j]
        if ch == "\\" and j + 1 < n:
            quoted = True
            word.append(command[j + 1])
            j += 2
        elif ch in ("'", '"'):
            quoted = True
            end = command.find(ch, j + 1)
            end = n if end < 0 else end
            word.append(command[j + 1:end])
            j = end + 1
        else:
            word.append(ch)
            j += 1
    return "".join(word), quoted, j


def _split_heredocs(command: str, trace: dict | None = None) -> tuple[str, list[tuple[str, str, bool]]]:
    """Split ``command`` into (commands-only text, [(owner line, body, quoted)]).

    A lexer, not a per-line regex (XERK-1256): a regex found `<<` wherever it
    sat, so the here-string `cat <<<x`, a quoted `echo '<<x'` and a comment
    `# <<x` each opened a "heredoc" that swallowed every following line up to
    one reading `x` — commands bash runs, never classified. Only an operator
    outside quotes and comments opens one, and arithmetic `$((1<<2))` is a
    shift. ``quoted`` is whether the delimiter was, i.e. whether bash leaves
    the body literal or expands `$(…)` and backticks inside it.

    A ``trace`` dict gets the kept pieces (`"kept"`) and each operator
    (`"ops"`: [piece index, owner number, body, quoted]), so a rewrite can
    replace an operator where the lexer found it (XERK-1658).
    """
    kept: list[str] = []
    ops: list[list] = []
    pending_ops: list[int] = []
    owner_no = 0
    bodies: list[tuple[str, str, bool]] = []
    pending: list[tuple[str, bool, bool]] = []  # (delimiter, quoted, strip tabs)
    # '"' a double-quoted string, '(' a `$(…)`/`(…)` group (quoting restarts in
    # one, even inside a string), 'p' a `${…}`.
    stack: list[str] = []
    line_start = 0  # index into ``kept`` of the current line's first piece
    i, n = 0, len(command)
    comment_nl = -1  # where the last comment ended (`_is_comment`)
    while i < n:
        ch = command[i]
        top = stack[-1] if stack else ""
        if ch == "\\":
            kept.append(command[i:i + 2])
            i += 2
            continue
        if ch == "`":
            end = command.find("`", i + 1)
            end = n - 1 if end < 0 else end
            kept.append(command[i:end + 1])
            i = end + 1
            continue
        if command.startswith("$((", i) or (top != '"' and command.startswith("((", i)):
            # Arithmetic: its `<<` is a shift. Skip to the matching `))`.
            depth, j = 0, i
            while j < n:
                if command[j] == "(":
                    depth += 1
                elif command[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            kept.append(command[i:j + 1])
            i = j + 1
            continue
        if ch == "$" and command[i + 1:i + 2] in ("(", "{"):
            stack.append("(" if command[i + 1] == "(" else "p")
            kept.append(command[i:i + 2])
            i += 2
            continue
        if top == '"':
            if ch == '"':
                stack.pop()
            kept.append(ch)
            i += 1
            continue
        if ch == "'" or (ch == "$" and command[i + 1:i + 2] == "'"):
            j = i + (2 if ch == "$" else 1)
            while j < n and command[j] != "'":
                j += 2 if ch == "$" and command[j] == "\\" else 1
            kept.append(command[i:j + 1])
            i = j + 1
            continue
        if ch == '"':
            stack.append('"')
        elif ch == "(":
            stack.append("(")
        elif ch == ")" and top == "(":
            stack.pop()
        elif ch == "}" and top == "p":
            stack.pop()
        elif ch == "#" and top != "p" and _is_comment(command, i, comment_nl):
            end = command.find("\n", i)
            end = comment_nl = n if end < 0 else end
            kept.append(command[i:end])
            i = end
            continue
        elif top == "p":
            pass  # `${x:-<<y}` is a word, not a redirection
        elif command.startswith("<<<", i):
            kept.append("<<<")
            i += 3
            continue
        elif command.startswith("<<", i):
            j = i + 2
            strip_tabs = command[j:j + 1] == "-"
            j += strip_tabs
            while j < n and command[j] in " \t":
                j += 1
            delim, quoted, end = _heredoc_word(command, j)
            if delim:
                pending.append((delim, quoted, strip_tabs))
                pending_ops.append(len(ops))
                ops.append([len(kept), owner_no, "", quoted])
            kept.append(command[i:end])
            i = end
            continue
        elif ch == "\n" and pending:
            # Bodies start after the line the operators sit on, in order.
            owner = "".join(kept[line_start:])
            kept.append("\n")
            i += 1
            for k, (delim, quoted, strip_tabs) in enumerate(pending):
                body: list[str] = []
                while i < n:
                    end = command.find("\n", i)
                    end = n if end < 0 else end
                    line = command[i:end]
                    i = end + 1
                    # A looser end than bash's (it wants the exact line) only
                    # ever ends a body EARLIER, classifying more, never less.
                    if (line.lstrip("\t") if strip_tabs else line).strip() == delim:
                        break
                    body.append(line)
                bodies.append((owner, "\n".join(body), quoted))
                ops[pending_ops[k]][2] = "\n".join(body)
            pending = []
            pending_ops = []
            owner_no += 1
            line_start = len(kept)
            continue
        if ch == "\n":
            line_start = len(kept) + 1
        kept.append(ch)
        i += 1
    if trace is not None:
        trace["kept"], trace["ops"] = kept, ops[:len(bodies)]
    return "".join(kept), bodies


def _split_on_operators(command: str, include_pipe: bool = True,
                        keep_redirects: bool = False, groups: bool = False) -> list[str]:
    """Split on shell operators that are NOT inside quotes.

    Splitting the raw string severed a quoted script mid-quote, so a shell's
    `-c` argument was reduced to its first WORD and the rest became a segment of
    its own: `bash -c 'rm -rf /etc; echo done'` became
    `["bash -c 'rm", "-rf /etc", "echo done'"]`, and `-c`'s argument was the bare
    token `'rm`. It only ever fired when the destructive command came FIRST
    inside the quotes, which is why every existing test — all of which write
    `bash -c 'cd /tmp; rm -rf /etc'` — missed it (XERK-235).

    Stripping stray quotes in the tokenizer instead is NOT the fix: it turns
    `rg -n 'shutdown|reboot' ansible/` into a power-state command.

    Three more things are not operators (XERK-1256):
    - a `#` comment, whose apostrophe (`# don't`) opened a "quote" that hid
      every command after it;
    - anything inside backticks, so `` `|`rm -rf / `` stays one segment;
    - the `|` between `case` pattern alternatives: `reboot|shutdown) …` read
      as the power command `reboot`. A plain pattern is dropped, not emitted —
      it is never a command — unless it holds a substitution, which runs.

    `|&` is ONE operator, a pipe that carries stderr too, and the `&` of a
    redirection (`2>&1`, `<&3`, `&>f`) none at all: cutting either severed a
    producer from the shell it feeds — `echo … |& bash`, `echo … 2>&1 | sh`
    (XERK-1614).

    ``groups`` keeps every `( … )`, `$( … )`, `<( … )`, `>( … )` and `{ …; }`
    whole, as the shell does. Only the stdin-feed walk asks for it: there a
    cut inside a group severs a producer from its reader (`{ echo …; } | sh`,
    `echo … | X=<(a; b) bash`); every other caller relies on the group pass in
    `_expand`, which reads bodies itself.
    """
    out: list[str] = []
    buf: list[str] = []
    quote: str | None = None
    # `case` state: how many are open, whether the next `in` is a case's, and
    # whether we are reading a pattern (with its extglob paren depth).
    case_depth = 0
    want_in = False
    in_pattern = False
    pat_parens = 0
    # Open `${…}` expansions, and the `$(` groups inside them: a `#` inside one
    # is text, so `${y:- #}; rm -rf /` must not hide the `rm` as a comment, and
    # the `}` in `${a:-$(echo }) #}` closes nothing (XERK-1585).
    braces: list[str] = []
    brace_at: list[int] = []  # where each of ``braces`` opened
    # With ``groups``: the open `(`/`{` groups, innermost last.
    opened: list[str] = []
    substs: dict[int, int] | None = None
    i, n = 0, len(command)

    # How many leading chunks of `buf` are known blank: `buf` only grows
    # between resets, so this scans each chunk once. Re-joining `buf` per
    # character made a long blank pattern quadratic (XERK-1601).
    blank_n = 0

    # Where a redirection's `&`/`|` may instead be an operator: (index of that
    # one-char chunk in `buf`, the twin prefix that rebuilds the redirection).
    cuts: list[tuple[int, str]] = []
    twin = ""  # the stage walk's: a split redirection, rebuilt on the next piece

    def flush() -> None:
        nonlocal buf, blank_n, twin
        if cuts:
            # Each piece as split, its twin, and the whole simple command as
            # bash reads it — a redirection may sit between a command's words
            # (`rm -rf 2>&1 /`, `rm -rf &>/dev/null /etc`) (XERK-1631). Pieces
            # are slices of `buf`, so a run of cuts stays linear.
            prev = 0
            for idx, prefix in cuts:
                out.append("".join(buf[prev:idx]))
                if prev and cut_prefix:
                    out.append(cut_prefix + out[-1])
                cut_prefix = prefix
                prev = idx + 1
            out.append("".join(buf[prev:]))
            if cut_prefix:
                out.append(cut_prefix + out[-1])
            cuts.clear()
        out.append("".join(buf))
        if twin:
            out.append(twin + out[-1])
            twin = ""
        buf = []
        blank_n = 0

    def buf_blank() -> bool:
        nonlocal blank_n
        while blank_n < len(buf) and not buf[blank_n].strip():
            blank_n += 1
        return blank_n == len(buf)

    comment_nl = -1  # where the last comment ended (`_is_comment`)
    while i < n:
        ch = command[i]
        if quote:
            buf.append(ch)
            # Inside double quotes a backslash escapes the next character;
            # inside single quotes it does not, and nothing ends them but `'`.
            # Inside backticks it escapes, as in double quotes.
            if ch == "\\" and quote != "'" and i + 1 < n:
                buf.append(command[i + 1])
                i += 2
                continue
            if quote == '"' and command.startswith("$(", i) and not _MAIN_PARSE[0] \
                    and _live_dollar(command, i):
                # Its body quotes afresh: `"$(echo ")'")"; rm -rf /` (XERK-1621).
                if substs is None:
                    substs = {m.start(): m.end() for m in _find_substs(command)}
                end = substs.get(i, 0)
                if end > i + 2:
                    if '"' in command[i:end] or "'" in command[i:end]:
                        _MAIN_PARSE_SEEN[0] = True
                    buf.append(command[i + 1:end])
                    i = end
                    continue
            if quote == '"' and command.startswith("${", i) and not _MAIN_PARSE[0] \
                    and _live_dollar(command, i):
                # A `"` inside a string's `${…}` nests, never closes the
                # string: `"${y:-"it's"}"; rm -rf /` read its `'` as an open
                # quote that hid the `rm` (XERK-1621).
                close = _brace_end(command, i, True)
                if close > 0:
                    buf.append(command[i + 1:close + 1])
                    i = close + 1
                    continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(command[i + 1])
            i += 2
            continue
        if command.startswith("${", i) and _BRACE_OTHER_SHELL[0] \
                and _live_dollar(command, i) and _bad_brace(command, i):
            # Read as dash reads it (see `_bad_brace`, `_brace_end`).
            close = _brace_end(command, i, False)
            close = n - 1 if close < 0 else close
            buf.append(command[i:close + 1])
            i = close + 1
            continue
        if command.startswith(("$$", "${", "$("), i) and (braces or command[i + 1] in "{$"):
            # `$$` is the PID, so `$${` opens nothing.
            if command[i + 1] != "$":
                braces.append(command[i + 1])
                brace_at.append(i)
            buf.append(command[i:i + 2])
            i += 2
            continue
        if braces and ch == "}" and braces[-1] == "{":
            braces.pop()
            brace_at.pop()
        elif braces and ch == ")" and braces[-1] == "(":
            braces.pop()
            brace_at.pop()
        # No group opens inside a `${…}`: its `(` is pattern text (`${x#(}`),
        # and an open "group" there swallowed every pipe after it (XERK-1614).
        elif groups and not braces and not in_pattern and ch == "(":
            opened.append("(")
        elif groups and not braces and opened and ch == ")" and opened[-1] == "(":
            opened.pop()
        elif (groups and not braces and ch == "{" and command[i + 1:i + 2] in (" ", "\t", "\n")
              and (_char_before(command, i) in ("", "{", "(", ";", "&", "|", "\n")
                   or _at_command_start(command, i))):
            # A `{` right after an opener starts a command at any depth;
            # `_at_command_start` stops after four keyword hops.
            opened.append("{")
        elif (groups and not braces and opened and ch == "}" and opened[-1] == "{"
              and command[i - 1:i] in (" ", "\t", "\n", ";")):
            opened.pop()
        elif (groups and not braces and not in_pattern and opened
              and opened[-1] in ("fi", "done", "esac")
              and _compound_closes(command, i, opened[-1])):
            # `fi`/`done`/`esac` ends the compound command kept whole above.
            closer = opened.pop()
            buf.append(closer)
            i += len(closer)
            continue
        elif (groups and not braces and not in_pattern
              and (_compound_kw := _compound_opener(command, i))):
            # `if`/`for`/`while`/`until`/`case` opens a compound command; keep
            # it and its body (`;`-separated keywords and all) in one segment,
            # as a `( )`/`{ }` group, so a pipe to or from it is not cut at the
            # inner `;` (XERK-1628). The body is opened by `_group_core`.
            opened.append(_COMPOUND_OPENERS[_compound_kw])
            buf.append(_compound_kw)
            i += len(_compound_kw)
            continue
        elif ch == "#" and not braces and _is_comment(command, i, comment_nl):
            end = command.find("\n", i)
            i = comment_nl = n if end < 0 else end
            continue
        if in_pattern:
            if buf_blank() and _word_at(command, i, "esac"):
                case_depth -= 1
                in_pattern = False
                buf.append("esac")
                i += 4
                continue
            if ch == "(":
                # The optional opener `(a|b)` is no extglob paren.
                pat_parens += 0 if buf_blank() else 1
            elif ch == ")" and pat_parens:
                pat_parens -= 1
            elif ch == ")":
                in_pattern = False
                # Split, not `\s*\|\s*`: that regex rescanned a blank run
                # from each of its blanks (XERK-1601).
                pattern = "|".join(alt.strip() for alt in "".join(buf).split("|"))
                if re.search(r"\s|\$\(|`|[<>]\(", pattern):
                    flush()
                else:
                    buf = []
                    blank_n = 0
                i += 1
                continue
            elif ch == "|":
                buf.append(ch)
                i += 1
                continue
        elif _word_at(command, i, "case") and _at_command_start(command, i):
            case_depth += 1
            want_in = True
        elif want_in and _word_at(command, i, "in") and command[i - 1:i] in (" ", "\t", "\n"):
            want_in = False
            in_pattern = True
            pat_parens = 0
            buf.append("in")
            flush()
            i += 2
            continue
        elif case_depth and command.startswith((";;", ";&"), i):
            flush()
            in_pattern = True
            pat_parens = 0
            i += 3 if command.startswith(";;&", i) else 2
            continue
        elif case_depth and _word_at(command, i, "esac") and _esac_closes(command, i):
            case_depth -= 1
        if opened:
            buf.append(ch)
            i += 1
            continue
        if (braces and braces[-1] == "{" and ch in ";\n&|"
                and _brace_end(command, brace_at[-1], False) > i):
            # An operator inside a `${…}` is text to bash: `${x/;/}/etc` and
            # `${x:<newline>-5}/etc` are one word, `/etc`. Read it both ways,
            # split as before and joined (see `flush`), since a misread close
            # must not hide every command after it (XERK-1680).
            op = command[i:i + 2] if command[i:i + 2] in ("&&", "||", "|&", ";;") else ch
            buf.append(op)
            cuts.append((len(buf) - 1, ""))
            i += len(op)
            continue
        if command[i:i + 2] in ("&&", "||"):
            flush()
            i += 2
            continue
        if command.startswith("|&", i):
            if include_pipe:
                flush()
            else:
                buf.append("|&")
            i += 2
            continue
        if command.startswith("&>", i):
            # `&> >(sh)`/`&>> >(sh)` is a bash redirect to a process substitution
            # (dash has no `>(`), so keep it with the stage to feed the sub
            # (XERK-1628). The op is read FIRST so the `>(` gate skips past the
            # whole `&>>`, not just `&>`. A plain `&>file` falls through to the
            # `&` split, keeping dash's reading (`&` background + `>file`), which
            # catches `true &>/dev/null rm …`.
            op = "&>>" if command.startswith("&>>", i) else "&>"
            if command[i + len(op):].lstrip().startswith(">("):
                buf.append(op)
                i += len(op)
                continue
        if ch in (";", "\n", "&") or (include_pipe and ch == "|"):
            # The `&` of `2>&1` and the `|` of `>|f` may belong to a
            # redirection, which splitting cuts: `>/dev/null 2>&1 rm -rf /etc`
            # became `… 2>` and `1 rm -rf /etc`. Whether it does, the text
            # cannot say — `\>&` and an expansion that printed `>` leave a real
            # operator — so read the next segment BOTH ways: as split, and with
            # the redirection rebuilt (`>&1 rm -rf /etc`) (XERK-1616).
            redirected = ch in "&|" and bool(buf) and buf[-1].endswith(("<", ">"))
            live = False
            if redirected:
                # An escaped `\>` is no redirection.
                slashes, k = 0, len(buf) - 1
                chunk = buf[k][:-1]
                while True:
                    stripped = chunk.rstrip("\\")
                    slashes += len(chunk) - len(stripped)
                    if stripped or k == 0:
                        break
                    k -= 1
                    chunk = buf[k]
                live = slashes % 2 == 0
            if redirected and live and (keep_redirects or (
                    ch == "&" and _FD_DUP_RE.match(command, i + 1))):
                # ...except where a caller reads STAGES (the pipe-to-shell walk):
                # there the extra segments sat between `echo … 2>&1` and `| sh`
                # and hid the producer. Nor is a live `>&2`/`>&-` cut: split,
                # it only names a program `2` (an expansion that printed `>`
                # leaves `&` before a word, `x='>'; echo $x&rm …`), and a third
                # reading of every `2>&1` tripled real decisions (XERK-1631).
                buf.append(ch)
                i += 1
                continue
            if not keep_redirects and (redirected or (ch == "&" and command.startswith("&>", i))):
                # Both readings: split here (dash's `&>`, an escaped `\>&`, an
                # expansion that printed `>`) and joined (see `flush`). Not for
                # the stage walk: joined, an escaped `\>&1 | sh` fed sh.
                buf.append(ch)
                cuts.append((len(buf) - 1, ">" + ch if redirected else ""))
                i += 1
                continue
            flush()
            if redirected:
                twin = ">" + ch
            i += 1
            continue
        buf.append(ch)
        i += 1
    flush()
    if opened:
        # A group never closed is one this scan misread, and keeping it whole
        # would hide every operator after it: split as if ``groups`` were off.
        return _split_on_operators(command, include_pipe, keep_redirects)
    return [seg.strip() for seg in out if seg.strip()]


# What follows the `&` of a `>&`/`<&` that duplicates or closes an fd.
_FD_DUP_RE = re.compile(r"(?:[0-9]+|-)(?=[\s;&|()<>]|\Z)")


def _split_segments(command: str) -> list[str]:
    return _split_on_operators(command, include_pipe=True)


def _unwrap_group(segment: str) -> str:
    """Strip subshell/group wrappers so `(rm -rf /)` classifies as `rm -rf /`.

    Only brackets that WRAP the whole segment are stripped — `(a) 2>/tmp/f\\)`
    and `(a) | (b)` end in a closer that is not the opener's, so stripping `(`
    and the final `)` severed the real command (XERK-1628). One quote/escape/
    `$(…)`-aware scan records every opener's close; the concentric prefix is
    then peeled in O(n), not O(n²) per layer (XERK-1628 QA)."""
    seg = segment.strip()
    if seg[:1] not in ("(", "{"):
        return seg
    if not any(c in seg for c in "<>&\\'\"`"):
        # No redirect/escape/quote can hide a non-matching closer, so matched
        # first/last pairs are safe to strip directly.
        while len(seg) >= 2 and (
            (seg[0] == "(" and seg[-1] == ")") or (seg[0] == "{" and seg[-1] == "}")
        ):
            seg = seg[1:-1].strip().rstrip(";").strip()
        return seg
    # One pass recording each opener's matching close (`(`/`$(` → `)`, `{ `/
    # `${` → `}`), skipping quotes and escapes.
    close_of: dict[int, int] = {}
    stack: list[tuple[str, int]] = []
    i, n, q = 0, len(seg), None
    while i < n:
        c = seg[i]
        if q:
            if c == "\\" and q != "'" and i + 1 < n:
                i += 2
                continue
            if c == q:
                q = None
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c in ("'", '"', "`"):
            q = c
            i += 1
            continue
        if seg.startswith(("$(", "${"), i):
            stack.append((")" if seg[i + 1] == "(" else "}", i))
            i += 2
            continue
        if c == "(":
            stack.append((")", i))
        elif c == "{" and seg[i + 1:i + 2] in (" ", "\t", "\n"):
            stack.append(("}", i))
        elif c in (")", "}") and stack and stack[-1][0] == c:
            close_of[stack.pop()[1]] = i
        i += 1
    # Peel concentric wrappers: each layer's opener must sit at the front
    # (only whitespace before) and its close at the back (only whitespace/`;`
    # after) of the span still being stripped.
    lo, hi = 0, n
    while True:
        while lo < hi and seg[lo] in " \t\n":
            lo += 1
        if lo >= hi or seg[lo] not in ("(", "{"):
            break
        ci = close_of.get(lo)
        if ci is None or ci >= hi:
            break
        k = ci + 1
        while k < hi and seg[k] in " \t\n;":
            k += 1
        if k != hi:
            break
        lo, hi = lo + 1, ci
    return seg[lo:hi].strip().rstrip(";").strip()


def _join_continuations(segment: str) -> str:
    """``segment`` with each `\\<newline>` bash removes dropped: everywhere
    but inside single quotes. shlex instead kept the newline as text glued to
    the NEXT word, so `time \\<newline>rm -rf /etc` ran a program it read as
    `\\nrm`, and `$x \\<newline>rm` hid the `rm` from every reading (XERK-1615)."""
    if "\\\n" not in segment:
        return segment
    # `_quote_states` marks a live escape's backslash AND the character it
    # escapes; it knows `#` comments and the quoting `$(…)` restarts. A scan
    # of its own lost both: an apostrophe in `# don't` opened a "quote" and
    # every later continuation was kept (XERK-1615 QA).
    states = _quote_states(segment)
    out, last, i = [], 0, segment.find("\\\n")
    while i >= 0:
        if states[i] == states[i + 1] == "\\":
            out.append(segment[last:i])
            last = i + 2
        i = segment.find("\\\n", i + 1)
    out.append(segment[last:])
    return "".join(out)


def _word_end(s: str, i: int, stop: str | None = None) -> int:
    """Where the bash word starting at ``i`` ends (``stop`` None), or the
    index of the ``stop`` character closing the construct whose body starts
    at ``i`` (`)`, `]` or `"`); -1 when something never closes.

    Unlike shlex it keeps whitespace inside `${…}`, `$(…)`, `$((…))`, `$[…]`,
    backticks and nested brackets in the word, as bash does.
    """
    n = len(s)
    while i < n:
        ch = s[i]
        if stop is None and ch in " \t\n;&|<>()":
            return i
        if ch == stop:
            return i
        if ch == "\\":
            i += 2
            continue
        if ch == "`":
            j = i + 1
            while j < n and s[j] != "`":
                j += 2 if s[j] == "\\" else 1
            if j >= n:
                return -1
            i = j + 1
            continue
        if s.startswith("${", i):
            # Quoting is known here; looked up, it is a whole-line scan per `${`.
            j = _brace_end(s, i, quoted=stop == '"')
        elif s.startswith(("$(", "$["), i):
            j = _word_end(s, i + 2, ")" if s[i + 1] == "(" else "]")
        elif stop == '"':
            i += 1
            continue
        elif ch == '"':
            j = _word_end(s, i + 1, '"')
        elif ch == "'" or s.startswith("$'", i):
            j = i + 1 if ch == "'" else i + 2
            while j < n and s[j] != "'":
                j += 2 if ch == "$" and s[j] == "\\" else 1
            j = j if j < n else -1
        elif (stop, ch) in ((")", "("), ("]", "[")):
            j = _word_end(s, i + 1, stop)
        else:
            i += 1
            continue
        if j < 0:
            return -1
        i = j + 1
    return n if stop is None else -1


# The NAME of an assignment word; its subscript and `+=`/`=` are checked by
# `_prefix_assignment_end`.
_ASSIGN_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# A redirection operator, with its fd: `>`, `2>&`, `{fd}>`, `&>>`, `<<<`, `<<-`.
_REDIRECT_AT_RE = re.compile(r"(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>?|<<<|<<-?|<>|>>|>\||[<>]&?)")
# How many quoted levels `_unsplit_assignments` reads as scripts.
_MAX_UNSPLIT_DEPTH = 4
# What some reader of the line splits a word at: shlex at a blank, the
# splitter and a spliced `${v:-a;b}` at an operator.
_ASSIGN_SPLITS_RE = re.compile(r"[\s;&|<>]")


def _prefix_assignment_end(s: str, i: int) -> int:
    """End of the assignment word (`NAME=…`, `NAME+=…`, `NAME[sub]=…`) at
    ``i``, or -1 if none starts there or it never closes."""
    m = _ASSIGN_NAME_RE.match(s, i)
    if not m:
        return -1
    j = m.end()
    if s.startswith("[", j):
        j = _word_end(s, j + 1, "]")
        if j < 0:
            return -1
        j += 1
    if s.startswith("+=", j):
        j += 1
    if not s.startswith("=", j) or s.startswith("=(", j):
        return -1
    return _word_end(s, j + 1)


def _unsplit_assignments(command: str, depth: int = 0) -> str:
    out, last = [], 0
    for start, end, name in _unsplit_cuts(command, depth):
        out += (command[last:start], name)
        last = end
    out.append(command[last:])
    return "".join(out)


def _printed_unsplit(command: str, unsplit: str | None = None) -> list[str]:
    """``command`` with each substitution's PRINTED text spliced in, cut by
    `_unsplit_assignments`, for each splice whose cut differs (XERK-1645):
    `bash -c "$(echo 'X=${v:-a b}') rm …"` re-parses `X=${v:-a b} rm …`.

    Spliced plain (what a re-parse runs) and literal (`_literal`: the word
    bash splices in, so `"$(echo 'X=${v:-a')"' b} rm …'` stays one word).
    The body's own assignments stay unapplied (`assigns=False`): applied, they
    expanded the `${…}` it prints before the cut could see it. A cut equal to
    ``unsplit`` (the raw line's own cut) spliced the same way is skipped: that
    assignment was written, and is cut already."""
    cuts: list[str] = []
    if "$(" not in command and "`" not in command:
        return cuts
    if unsplit is None:
        unsplit = _unsplit_assignments(command)
    for literal in (False, True):
        def printed(m: "re.Match[str]", literal: bool = literal) -> str:
            return _subst_text(m, literal=literal, assigns=False)
        spliced = _sub_substs(command, printed)
        if spliced == command or "=" not in spliced:
            continue
        cut = _unsplit_assignments(spliced)
        if cut != spliced and cut not in cuts and cut != (
                _sub_substs(unsplit, printed) if unsplit != command else spliced):
            _spend(len(cut))
            cuts.append(cut)
    return cuts


# A function header or group opener leading a segment (`f(){ …`, `function f {`,
# `{ …`, `( …`), dropped before a raw segment's program word is read.
_RAW_SEG_OPENER_RE = re.compile(
    r"\s*(?:function\s+[^\s(){}]+\s*(?:\(\s*\))?\s*|[^\s(){}=]+\s*\(\s*\)\s*)?[{(]?\s*")


def _raw_printed_cuts(command: str, depth: int = 0) -> list[str]:
    """`_printed_unsplit` cuts of every `-c`/eval script ``command`` runs, read
    off its RAW text, at any nesting (XERK-1645 QA): a re-parse level is handed
    its script `${…}`-substituted, so `bash -c 'eval $(echo …X=${v:-a b}…)
    rm …'` reached the level that splices it as `X=a b`. Recurses into each
    script, each substitution body (`: $(bash -c '…')`, backticks, `<(…)`)
    and each unquoted heredoc body; each cut is a whole script to expand."""
    cuts: list[str] = []
    if depth > _MAX_UNSPLIT_DEPTH:
        return cuts
    # `$'…'` decoded before the split and the gate, as an ADDED reading: split
    # raw, its `\'` ended the quote early (`bash -c $'eval $(echo \'X=…\') rm
    # …; echo done'`) and a `\x24(` is no `$(`; but `_ANSI_C_RE` is quote-blind,
    # and alone it read a quoted `"$'\'"` as one and swallowed the line after it.
    for text in dict.fromkeys((command, _decode_ansi_c(command))):
        cuts += _raw_printed_walk(text, depth)
    return list(dict.fromkeys(cuts))


def _walk_owner_feeds_shell(text: str, owner: str, memo: dict | None = None) -> bool:
    """Whether the heredoc on ``owner`` (of heredoc-free ``text``) feeds a
    shell, judged as `_expand`'s heredoc site judges it (`bash<<'E'`,
    `{ bash; } <<'E'`, `$x <<'E'`, `cat <<'E'|bash|cat`), plus a shell, `.` or
    `source` named anywhere on the owner line (an added, over-reading test).
    ``memo`` holds one walk's per-line facts and per-owner answers: every
    heredoc on a line shares both, and recomputing them per heredoc made a
    250-heredoc line quadratic, past the deadline (XERK-1645 QA)."""
    memo = {} if memo is None else memo
    if owner in memo:
        return memo[owner]
    if any(_basename(t) in _SHELL_PROGS or t in (".", "source")
           for t in (w.strip("(){};&|") for w in _tokenize(_SUBST_RE.sub(" ", owner)))):
        memo[owner] = True
        return True
    if "\0facts" not in memo:
        memo["\0facts"] = (_var_values(text), _defined_names(text))
    vals, defined = memo["\0facts"]

    def feeds() -> bool:
        if "\0feeds" not in memo:
            memo["\0feeds"] = _line_feeds_shell(text)
        return memo["\0feeds"]
    memo[owner] = _heredoc_owner_feeds_shell(
        owner, feeds, lambda w: _owner_word_may_be_shell(w, vals, defined),
        lambda st: _stage_may_read_stdin(st, vals, defined))
    return memo[owner]


def _raw_printed_walk(command: str, depth: int) -> list[str]:
    """One reading of `_raw_printed_cuts`."""
    cuts: list[str] = []
    if "$(" not in command and "`" not in command:
        return cuts
    text, heredocs = _split_heredocs(command)
    owners: dict = {}
    for owner, body, quoted in heredocs:
        if not quoted:
            # As the shell reads it too: `\$'` there is a live ANSI-C string.
            for reading in _heredoc_readings(body):
                cuts += _raw_printed_cuts(reading, depth + 1)
        elif _walk_owner_feeds_shell(text, owner, owners):
            # A quoted body a shell runs (`bash <<'E'`, `cat <<'E' | bash`),
            # nested in another; a non-shell owner's (`cat <<'E' > f.sh`) is data.
            cuts += _raw_printed_cuts(body, depth + 1)
    for raw_seg in _split_segments(text):
        if "$(" not in raw_seg and "`" not in raw_seg:
            continue
        for m in _find_substs(raw_seg):
            cuts += _raw_printed_cuts(_subst_inner(m), depth + 1)
        seg = _unwrap_group(raw_seg)
        seg = seg[_RAW_SEG_OPENER_RE.match(seg).end():]
        words = _strip_prefixes(_tokenize(seg))
        if not words:
            continue
        prog = _bash_dequoted(_decode_ansi_c(words[0]))
        if prog == "eval":
            scripts = [" ".join(words[2:] if words[1:2] == ["--"] else words[1:])]
        elif prog == "trap":
            # The action string runs on the trap (`trap '…' EXIT`).
            scripts = words[2:3] if words[1:2] == ["--"] else words[1:2]
        else:
            scripts = _raw_shell_c_scripts(words)
            # A shell's here-string is its script (`bash <<< '…'`), its name
            # glued to it or not (`sh<<<'…'`).
            name = words[0].split("<<<", 1)[0]
            if _basename(name) in _SHELL_PROGS or _bash_dequoted(name) in (".", "source"):
                scripts += _herestrings(seg)
        for script in scripts:
            for reading in _script_readings(script):
                cuts += _printed_unsplit(reading)
                cuts += _raw_printed_cuts(reading, depth + 1)
    return cuts


def _unsplit_cuts(command: str, depth: int = 0) -> tuple[tuple[int, int, str], ...]:
    """`_unsplit_cuts_at` under the current reading: `_brace_end` parses a
    `${…}` per reading, so a cut cached under bash's hid dash's (XERK-1620 QA)."""
    return _unsplit_cuts_at(command, depth, _reading())


@functools.lru_cache(maxsize=64)
def _unsplit_cuts_at(command: str, depth: int,
                     reading: tuple) -> tuple[tuple[int, int, str], ...]:
    """``command`` with each assignment word that prefixes a command, and that
    holds an unquoted blank or operator character, cut down to its `NAME=`.

    bash keeps `X=${v:-a b}`, `X=$((1 + 2))`, `X=$(echo a; echo b)` and
    `a[1 + 1]=x` ONE word, so the command after it runs; shlex and the
    splitter cut it at the blank or `;`, leaving a fragment (`b}`, `+`) as the
    program word and the command unclassified (XERK-1620). Only an ADDED
    reading: the scan below is not bash, and where it misjudges a word's end
    the line's own reading still stands. A substitution's body is skipped
    whole here; its own commands are read when it is expanded. A quoted
    string is scanned as a script too (`bash -c '…'`, `eval '…'`,
    `echo '…' | bash`), since the splice of `${v:-a b}` reaches it first.
    """
    cuts: list[tuple[int, int, str]] = []
    pending: list[tuple[int, int, str]] = []
    i, n, at_start, wrapped = 0, len(command), True, False
    try:
        while i < n:
            ch = command[i]
            if ch in " \t":
                i += 1
                continue
            redirect = _REDIRECT_AT_RE.match(command, i)
            if redirect:
                # `>/dev/null X=… cmd`: a redirection and its target may come
                # anywhere, before the assignments too (`{fd}>`, `2>&1`, `&>`).
                i = redirect.end()
                while i < n and command[i] in " \t":
                    i += 1
                # The target, a here-string's word or a heredoc's delimiter. A
                # here-string may be a script (`bash <<< 'X=… cmd'`).
                end = _word_end(command, i)
                if end < 0:
                    break
                if depth < _MAX_UNSPLIT_DEPTH:
                    cuts += _unsplit_quoted(command, i, end, depth)
                i = max(end, i)
                continue
            if ch in ";&|\n()":
                # Assignments with no command after them set the SHELL's
                # variables (`R=$(command -v ruff); $R …`): never cut those.
                at_start, wrapped, pending = True, False, []
                i += 1
                continue
            if ch == "#":
                end = command.find("\n", i)
                i = n if end < 0 else end
                continue
            if at_start or wrapped:
                end = _prefix_assignment_end(command, i)
                if end > i:
                    word = command[i:end]
                    if _ASSIGN_SPLITS_RE.search(_unquoted_text(word)):
                        cut = (i, end, _ASSIGN_NAME_RE.match(word).group(0) + "=")
                        (cuts if wrapped else pending).append(cut)
                    i = end
                    continue
            end = _word_end(command, i)
            if end <= i:
                break
            word = command[i:end]
            if depth < _MAX_UNSPLIT_DEPTH:
                cuts += _unsplit_quoted(command, i, end, depth)
            if at_start and (_basename(word) in _PREFIX_WORDS
                             or _bash_dequoted(_decode_ansi_c(word)) == "eval"):
                # A wrapper (`env -u N X=… cmd`, `sudo -u root X=… cmd`,
                # `timeout 5 env X=…`, `coproc N { X=… cmd; }`): every
                # assignment-shaped word to the end of the command is cut, flag
                # values and names included. So after `eval`, which re-joins
                # a printed `X=${v:-a` `b}` into one word (XERK-1645 QA). Only an added reading, so cutting
                # an argument costs nothing the line's own reading had.
                wrapped = True
                cuts += pending
                pending = []
            elif at_start and word == "function":
                # `function f { X=… cmd; }`: the name is no command; the
                # body's `{` opens one (XERK-1620 QA).
                j = end
                while j < n and command[j] in " \t":
                    j += 1
                i = max(_word_end(command, j), j)
                continue
            elif word not in _PREFIX_KEYWORDS:
                at_start = False
                cuts += pending
                pending = []
            i = end
    except RecursionError:
        return ()
    kept, last = [], 0
    for start, end, name in sorted(cuts):
        if start >= last:
            kept.append((start, end, name))
            last = end
    return tuple(kept)


# A `${` opener, also spelled with empty or split quoting a re-parse joins
# (`'X=$''{v:-a b}'`, `X='$'"{v:-a b}"`), or a bare `$name`.
_PARAM_OPEN_RE = re.compile(r"\$['\"]*\{|\$([A-Za-z_]\w*)")
def _glued_param_values(command: str, vals: dict[str, list[str]],
                        spelled: bool = True) -> str:
    """``command`` with every expansion that may hold a blank or operator
    character glued into one word, whatever quoting or nesting it sits in: a
    use of a name ``vals`` gives such a value becomes `_` (the line's own
    reading judges the value; spliced here, a long one bloated every segment
    it reached); any other `${…}` keeps its text, those characters made `_`.

    bash never splits an assignment's value, so `X=${v:-a b} <cmd>`, `s='a
    b'; X=$s <cmd>` and their joins through `eval 'X=${v:-a b}' '<cmd>'`,
    `echo 'X=…' '<cmd>' | bash`, a printed `$(echo 'X=…') <cmd>` or a `source
    <(…)` run <cmd>, while the guard spliced the value first and read `X=a`
    and the program `b` (XERK-1684). An ADDED reading only: a `${…}` span is
    found by brace depth with quoting ignored, so it may cover real code
    (`echo '${'; …; echo '}'`), which the line's own reading still reads."""
    glue = {name for name, values in vals.items()
            # A `\` may be an ANSI-C escape kept undecoded: `s=$'a\tb'` holds a tab.
            if any(_ASSIGN_SPLITS_RE.search(v) or "\\" in v for v in values)}
    return _glue_spans(command, glue, 0, spelled) if glue or "${" in command else command


def _odd_escapes_before(text: str, i: int) -> bool:
    """Whether an odd run of `\\` ends at ``i`` (the character there is escaped)."""
    j = i
    while j > 0 and text[j - 1] == "\\":
        j -= 1
    return (i - j) % 2 == 1


def _glue_spans(command: str, glue: set[str], in_value: int, spelled: bool) -> str:
    """`_glued_param_values` with its glued values worked out. Only an
    expansion after a `=` (or nested in a glued one: ``in_value`` levels) is glued:
    without one no assignment can hold it, and gluing every `$x` doubled
    lines that only use one. Any `=` earlier on the line counts, quoted or
    not: a scan for where its WORD ends had to be bash's own lexer, and each
    misread (`"$(echo "a b")"`, a case `)`, `<(…)`) dropped a glue (QA)."""
    if in_value > _MAX_NESTED_VARS + 1:
        # As deep as `_substitute_vars` refuses; each level rescans its text.
        raise _ExpansionTooLarge
    out, last = [], 0
    # A `\` counts as a `=` too: an escape can print one (`printf 'X\x3d$s'`, QA).
    first_eq = -1 if in_value else min((i for i in (command.find("="), command.find("\\"))
                                        if i >= 0), default=-1)

    def in_assignment(at: int) -> bool:
        return bool(in_value) or 0 <= first_eq < at

    # Each `${`'s closing `}`, matched in ONE pass: scanning on from each
    # opener rescanned the line per unclosed one (`${a:-${` × 2000, QA). As
    # in bash, only a `${` nests: a bare `{` is text, so `${v:-a { b}` closes
    # at the first `}` (paired with the `{`, it read as unclosed, QA).
    # ``spelled`` also opens `$''{`, `$'"{` and an escaped `\${`, as a re-parse
    # may join them; read without it too, since to THIS parse they are text,
    # and one before a span's `}` took it (`${v:-a b$"{"}`, QA).
    opens = {m.end() - 1 for m in _PARAM_OPEN_RE.finditer(command) if m.group(1) is None
             and (spelled or m.group(0) == "${" and not _odd_escapes_before(command, m.start()))}
    closes, stack, i, n = {}, [], 0, len(command)
    while i < n:
        ch = command[i]
        if ch == "\\":
            i += 2
            continue
        if i in opens:
            stack.append(i)
        elif ch == "}" and stack:
            closes[stack.pop()] = i
        i += 1

    for m in _PARAM_OPEN_RE.finditer(command):
        if m.start() < last:
            continue
        if m.group(1) is not None:
            if m.group(1) in glue and in_assignment(m.start()):
                out += (command[last:m.start()], "_")
                last = m.end()
            continue
        close = closes.get(m.end() - 1, -1)
        j = close + 1
        if close < 0 or not in_assignment(m.start()):
            # Unclosed (`${v:-{}`): its text is no span, but a use after it still is.
            continue
        name = _ASSIGN_NAME_RE.match(command, m.end())
        if name and name.group(0) in glue or command.startswith("!", m.end()):
            # ...and an indirect `${!n}`, whose value is another name's (QA).
            out += (command[last:m.start()], "_")
        else:
            # A use nested in it glued too: `${v:-a${s}b}` with `s=' '`.
            inner = _glue_spans(command[m.end():j - 1], glue, in_value + 1, spelled)
            out += (command[last:m.end()], _ASSIGN_SPLITS_RE.sub("_", inner), "}")
        last = j
    if not out:
        return command
    out.append(command[last:])
    return "".join(out)


def _unquoted_text(word: str) -> str:
    """``word`` without its quoted runs: a blank in `X='a b'` splits nothing,
    so that assignment needs no cut (`_ENV_ASSIGN` reads it whole)."""
    out, i, n = [], 0, len(word)
    while i < n:
        ch = word[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "'" or word.startswith("$'", i):
            j = i + 1 if ch == "'" else i + 2
            while j < n and word[j] != "'":
                j += 2 if ch == "$" and word[j] == "\\" else 1
        elif ch == '"':
            j = _word_end(word, i + 1, '"')
        else:
            out.append(ch)
            i += 1
            continue
        if j < 0 or j >= n:
            return word
        i = j + 1
    return "".join(out)


def _unsplit_quoted(command: str, i: int, end: int, depth: int) -> list[tuple[int, int, str]]:
    """Cuts inside each `'…'`/`"…"` script in the word ``command[i:end]``.

    A script spread over several quoted pieces (`sh -c 'X=…"'"'"'…'`) is cut
    whole: dequoted, and the word replaced by its cut text in one `'…'`.
    Each piece alone may not close, and nothing is cut (XERK-1620 QA)."""
    word = command[i:end]
    if "=" in word and len(re.findall(r"['\"]", word)) > 2:
        script = _bash_dequoted(word)
        if script is not None:
            cut = _unsplit_assignments(script, depth + 1)
            if cut != script:
                return [(i, end, shlex.quote(cut))]
    cuts = []
    while i < end:
        ch = command[i]
        if ch == "\\":
            i += 2
            continue
        close = -1
        if ch == "'":
            close = command.find("'", i + 1)
        elif ch == '"':
            close = _word_end(command, i + 1, '"')
        if close < 0 or close >= end:
            i += 1
            continue
        inner = command[i + 1:close]
        if "=" in inner:
            if ch == '"':
                # A re-parse reads the string with its escapes removed:
                # `bash -c "X=\$((1 + 2)) rm …"` runs `X=$((1 + 2)) rm …`.
                # Each cut is mapped back through them.
                text, at = _dq_unescaped(inner)
                for start, stop, name in _unsplit_cuts(text, depth + 1):
                    cuts.append((i + 1 + at[start], i + 1 + at[stop - 1] + 1,
                                 re.sub(r'([$`"\\])', r"\\\1", name)))
            else:
                cuts += [(i + 1 + start, i + 1 + stop, name)
                         for start, stop, name in _unsplit_cuts(inner, depth + 1)]
        i = close + 1
    return cuts


def _bash_dequoted(word: str) -> str | None:
    """The one word ``word`` is to bash, quotes removed, or None if it is not
    one plain word. Not shlex: shlex keeps the `\\` of `"\\$((…))"`, which
    bash drops, and that hid the assignment behind it (XERK-1620 QA)."""
    out, i, n = [], 0, len(word)
    while i < n:
        ch = word[i]
        if ch == "\\":
            if word[i + 1:i + 2] != "\n":  # a `\<newline>` continues the line
                out.append(word[i + 1:i + 2])
            i += 2
        elif ch == "'":
            close = word.find("'", i + 1)
            if close < 0:
                return None
            out.append(word[i + 1:close])
            i = close + 1
        elif ch == '"':
            close = _word_end(word, i + 1, '"')
            if close < 0:
                return None
            out.append(_dq_unescaped(word[i + 1:close])[0])
            i = close + 1
        elif ch in " \t\n" or word.startswith("$'", i) or word.startswith('$"', i):
            return None
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _dq_unescaped(text: str) -> tuple[str, list[int]]:
    """``text`` as bash reads it inside `"…"` (`\\` before `$`, a backtick,
    `"`, `\\` or a newline dropped), and where each character came from."""
    out, at, i = [], [], 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text) and text[i + 1] in '$`"\\\n':
            i += 1
        out.append(text[i])
        at.append(i)
        i += 1
    return "".join(out), at


# A bare `(` `)` pair, blanks allowed around and inside: in a simple command it
# can only be a function header, so `_glue_func_parens` closes it up.
_FUNC_PARENS_RE = re.compile(r"[ \t]*\([ \t]*\)")
# A character that may stand in a function name: no blank, operator, quote,
# expansion or brace.
_FUNC_NAME_CHARS = re.compile(r"[^\s()<>|&;'\"\\`$={}]")


def _glue_func_parens(segment: str) -> str:
    """``segment`` with every BARE `()` header closed up to `name()`.

    `()` is an operator, so the shell splits `f(){`, `f ( ) {` and `f (){` where
    shlex does not, and read glued the header hid the body's first word
    (XERK-1633). It is done on the raw text because shlex drops quoting: joined
    after it, `rm -rf / '()'` read as a header and hid the `rm` (XERK-1633 QA).
    Its result is only ever an ADDED reading (see `_expand`): a printed `()`
    (`` rm -rf /etc `echo '()'` ``) or an extglob `@()` is bare here and is
    no header to bash, so the unglued text is still read as well.
    zsh's `f g () { …; }` defines every name before the `()`, so each bare word
    there becomes a header of its own. `$(`, `<(`, `=(` and `((` stay put."""
    if "(" not in segment:
        return segment
    # `f \<newline>() {` is `f () {` to the shell (XERK-1633 QA).
    segment = _join_continuations(segment)
    if not _FUNC_PARENS_RE.search(segment):
        return segment
    states = _quote_states(segment)

    def bare(i: int) -> bool:
        return not states[i] and bool(_FUNC_NAME_CHARS.match(segment[i]))

    out, last = [], 0
    for m in _FUNC_PARENS_RE.finditer(segment):
        open_at = segment.index("(", m.start())
        close_at = m.end() - 1
        before = segment[m.start() - 1] if m.start() else ""
        if (before and before in "$<>=(") or segment[close_at + 1:close_at + 2] == ")":
            continue
        if states[open_at] or states[close_at] or m.start() < last:
            continue
        # The name glued to the `()`, then any further bare names before it.
        name_at = m.start()
        while name_at > last and bare(name_at - 1):
            name_at -= 1
        names, pos = [], name_at
        while True:
            gap = pos
            while gap > last and segment[gap - 1] in " \t":
                gap -= 1
            word = gap
            while word > last and bare(word - 1):
                word -= 1
            if gap == pos or word == gap or (
                    word > 0 and segment[word - 1] not in " \t\n;&|(){}"):
                break
            if segment[word:gap] in _SHELL_KEYWORDS or segment[word:gap] == "function":
                break
            names.append(segment[word:gap])
            pos = word
        out.append(segment[last:pos])
        out.extend(name + "() " for name in reversed(names))
        # Idempotent: a glued header is left as it is, so the reading
        # `_expand` adds settles in one step.
        after = segment[m.end():m.end() + 1]
        out.append(segment[name_at:m.start()] + ("()" if not after or after.isspace() else "() "))
        last = m.end()
    out.append(segment[last:])
    return "".join(out)


def _drop_trailing_escape(text: str) -> str | None:
    """``text`` with the lone live `\\` ending it (trailing blanks aside)
    dropped, or None when it ends otherwise (XERK-1646).

    zsh drops that `\\`, and so does every shell reading it as a line
    continuation (a here-string's `text\\` + newline, a `\\<newline>` split
    at its newline). bash keeps it as a literal `\\` glued to the last word,
    which only ever makes that word LESS than the dropped reading's (`/etc\\`,
    `sh\\`, `*\\`): nothing follows it in this parse, and in any later
    parse it ends the text again. So the dropped reading is the one to judge.

    Judged by `_quote_states` and the run's parity, never by shlex: shlex's
    `comments` takes a `#` glued to a word (`'…'#\\`) for a comment, and
    without it `# don't` is an open quote.
    """
    body = text.rstrip(" \t\n")
    if not body.endswith("\\"):
        return None
    run = len(body) - len(body.rstrip("\\"))
    if run % 2 == 0 or _quote_states(body)[-1] != "\\":
        return None
    return body[:-1] + text[len(body):]


# The blanks shlex splits at; bash keeps them inside a `${…}` (`\r` it never splits at).
_SHLEX_BLANKS = " \t\r\n"


def _keep_brace_blanks(segment: str) -> tuple[str, dict[str, str]] | None:
    """``segment`` with each blank inside an unquoted `${…}` swapped for a
    private-use character the text does not hold, and the map back; None when
    there is none to keep.

    bash reads `${x: -5}/etc` as ONE word (a negative substring offset needs
    the blank); shlex cut it into `${x:` and `-5}/etc`, so no target rule saw
    the `/etc` it expands to (XERK-1680). Quoted blanks are shlex's already.
    A `${` followed by a blank names no parameter: it is skipped, so the
    guard's own `${ <placeholder>}` splices stay split as before.
    """
    if "${" not in segment:
        return None
    states = _quote_states(segment)
    out = list(segment)
    i = segment.find("${")
    kept = False
    while i >= 0:
        end = -1
        if states[i] == "" and segment[i + 2:i + 3] not in ("", *_SHLEX_BLANKS) \
                and _live_dollar(segment, i):
            end = _brace_end(segment, i, False)
        if end < 0:
            i = segment.find("${", i + 2)
            continue
        for k in range(i + 2, end):
            if segment[k] in _SHLEX_BLANKS and states[k] == "":
                out[k] = None
                kept = True
        i = segment.find("${", end + 1)
    if not kept:
        return None
    # Stand-ins the text does not hold: a planted one must not read as a blank.
    have = set(segment)
    free = (chr(c) for c in range(0xE000, 0xF900) if chr(c) not in have)
    stand = {b: next(free) for b in _SHLEX_BLANKS}
    text = "".join(stand[segment[k]] if c is None else c for k, c in enumerate(out))
    return text, {v: k for k, v in stand.items()}


@functools.lru_cache(maxsize=512)
def _tokenize_cached(segment: str) -> tuple[str, ...]:
    segment = _join_continuations(segment)
    kept = _keep_brace_blanks(segment)
    if kept is None:
        return _tokenize_split(segment)
    text, back = kept
    back_table = str.maketrans(back)
    return tuple(t.translate(back_table) for t in _tokenize_split(text))


def _tokenize_split(segment: str) -> tuple[str, ...]:
    try:
        return tuple(shlex.split(segment, posix=True))
    except ValueError:
        pass
    # A lone `\` ending the text makes shlex raise, and the whitespace split
    # below kept a `-c`/`eval` script's quotes, so `bash -c 'rm …'\` was
    # never re-read (XERK-1646). Every route tokenizes — the stdin-feed walk's
    # stages, a segment whose escaped blank the split ate — so the reading
    # goes here, and costs nothing per nesting level.
    dropped = _drop_trailing_escape(segment)
    if dropped is not None:
        try:
            return tuple(shlex.split(dropped, posix=True))
        except ValueError:
            pass
    return tuple(segment.split())


def _tokenize(segment: str) -> list[str]:
    """Best-effort shell tokenisation; falls back to whitespace split.

    Memoised because the same segment is tokenised several times per command
    (the `piped_operands` sweep, then the classification pass, then each
    unwrapped executor), and `shlex` is the most expensive thing this hook does
    — it runs before EVERY Bash call, so its cost is on the agent's critical
    path. A fresh list is returned so callers can treat it as their own.
    """
    return list(_tokenize_cached(segment))


def _strip_prefixes(tokens: list[str]) -> list[str]:
    """Drop leading env-assignments, shell keywords and wrapper words.

    A wrapper's own options are dropped too: stopping at the first `-` token
    meant `sudo -u root rm -rf /` and `env -i rm -rf /` classified as nothing
    at all, which is the opposite of failing safe.
    """
    out = list(tokens)
    while out:
        head = out[0]
        if _ENV_ASSIGN.match(head) or head in _SHELL_KEYWORDS:
            out.pop(0)
            continue
        if _FUNC_DEF_RE.match(head) or _CASE_PATTERN_RE.match(head):
            out.pop(0)
            continue
        # A redirection may come before the program: `2>/dev/null rm -rf /etc`
        # runs `rm` (XERK-1616). Its target goes too when the operator stands
        # alone. `<(…)`/`>(…)` is a process substitution, not a redirection.
        redirect = None if head[:2] in ("<(", ">(") else _REDIRECT_RE.match(head)
        if redirect:
            out.pop(0)
            if not redirect.group(1) and out:
                out.pop(0)
            continue
        if head == "function":
            out.pop(0)
            if out:
                out.pop(0)  # the function's name
            # zsh's `function f g { …; }` names several; drop them up to the
            # body's opener — only when one follows, or the body's own words go.
            opener = next((i for i, t in enumerate(out)
                           if t in ("{", "(") or "()" in t), None)
            if opener is not None:
                del out[:opener]
            continue
        if head in _WORDLIST_HEADS:
            out.pop(0)
            while out and out[0] != "in":
                out.pop(0)
            if out:
                out.pop(0)  # the `in` itself
            continue
        if _basename(head) in _PREFIX_WORDS:
            wrapper = _basename(head)
            out.pop(0)
            # The wrapper's own flags, plus any value they consume.
            takes_value = _PREFIX_OPTS_WITH_VALUE.get(wrapper, set())
            # `env -` is `env -i`: a bare dash is env's option, not its program.
            while out and out[0].startswith("-") and (len(out[0]) > 1 or wrapper == "env"):
                opt = out.pop(0)
                split = _env_split_string(opt, out) if wrapper == "env" else None
                if split is not None:
                    # `env -S "sh -c 'rm -rf /'"` runs its operand as a command
                    # LINE, which classified as one unknown program (XERK-1539).
                    out[:0] = _tokenize(split)
                    continue
                if opt == "--":
                    break
                if (opt not in _PREFIX_LONG_FLAGS.get(wrapper, ())
                        and _opt_takes_next(opt, takes_value) and out):
                    out.pop(0)
            # env takes ANY word holding `=` as an assignment, a name bash would
            # refuse included: `env 'a;x=1' rm -rf /etc` runs `rm` (XERK-1657 QA).
            while wrapper == "env" and out and "=" in out[0] and not out[0].startswith("-"):
                out.pop(0)
            # `timeout 5s cmd` / `nice 10 cmd`: a bare duration/priority operand.
            # timeout's is REQUIRED, so it goes whatever it looks like: kept,
            # `timeout ${T:-5} bash` read as the program `${T:-5}` (XERK-1618).
            # chrt's priority is positional too (`chrt -o 0 cmd`); a newer chrt
            # may omit it, so only a number or an expansion is taken for it.
            if out and (wrapper == "timeout"
                        or wrapper == "nice" and re.match(r"^[0-9]", out[0])
                        or wrapper == "chrt" and re.match(r"^[-+]?[0-9]|^[$`]", out[0])):
                out.pop(0)
            # BusyBox rm has no preserve-root: `busybox rm -rf "$x/$y"` empties
            # `/`, so it is read as GNU rm told not to refuse it (XERK-1687).
            if wrapper == "busybox" and out and _basename(out[0]) == "rm":
                out.insert(1, "--no-preserve-root")
            # `coproc NAME { cmd; }`: a name only ever precedes a compound
            # command, whose body runs (XERK-1620 QA).
            if wrapper == "coproc" and len(out) > 1 and out[1] in ("{", "(", "while", "until",
                                                                    "if", "for", "case"):
                out.pop(0)
            continue
        break
    return out


def _opt_takes_next(opt: str, takes_value: set[str]) -> bool:
    """Whether a wrapper option consumes the NEXT token, read as getopt does.

    `-nu`: a short cluster's value letter takes the rest of the token, or the
    next token when it ends the cluster. `--kill`: getopt_long accepts any
    unambiguous prefix of a long option; an ambiguous one aborts the wrapper,
    so taking the value then hides nothing that runs. An exact valueless
    long option that prefixes a value one is the caller's to exclude
    (`_PREFIX_LONG_FLAGS`)."""
    if opt.startswith("--"):
        if "=" in opt:
            return False
        return opt in takes_value or any(
            v.startswith(opt) for v in takes_value if v.startswith("--"))
    for j in range(1, len(opt)):
        if "-" + opt[j] in takes_value:
            return j == len(opt) - 1
    return False


def _env_split_string(opt: str, rest: list[str]) -> str | None:
    """The command line `env -S`/`--split-string` carries, consuming a separate
    value from ``rest``; None for any other `env` option.

    A short cluster is walked letter by letter: `env`'s own value-taking short
    options (`-u NAME`, `-C DIR`) consume the REST of the token, so an `S` after
    one of them is part of that value, not `-S` — `env -uSHELL rm -rf /` runs
    `rm`, and reading the glued `SHELL` as a command line hid it (XERK-1539)."""
    if opt.startswith("--split-string"):
        if "=" in opt:
            return opt.split("=", 1)[1]
        return rest.pop(0) if rest else ""
    if opt.startswith("--"):
        return None
    for j in range(1, len(opt)):
        c = opt[j]
        if c == "S":
            return opt[j + 1:] or (rest.pop(0) if rest else "")
        if c in ("u", "C"):  # consumes the remainder (or next token) as its value
            return None
    return None


# A script path that is the shell's own stdin or an inherited fd — what
# `bash -`, `source /dev/stdin` and `. <(…)` (bash passes `/dev/fd/63`) read.
# A shell reading its script from stdin or an inherited fd. The fd may be a
# literal number or a variable an `exec {fd}<<<…`/`exec N<<…` opened, left
# unresolved (`bash /dev/fd/$fd`, XERK-1628); only reached once that line has
# fed text, so a `$var` fd there fails closed.
_STDIN_SCRIPT_RE = re.compile(
    r"^(?:-|/dev/stdin|/dev/fd/(?:\d+|\$\{?\w+\}?)|/proc/(?:self|\d+)/fd/(?:\d+|\$\{?\w+\}?))$")
# Shell options that consume the NEXT token, so it is not taken as the script.
_SHELL_OPTS_WITH_VALUE = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# A redirection word: `2>&1`, `>/dev/null`, `<`, `<<<`. Its target follows
# when the operator stands alone.
# `{fd}>f` names the fd it opens; `2>f` numbers it.
_REDIRECT_RE = re.compile(r"^(?:\d*|\{[A-Za-z_]\w*\})(?:<<<|<<-?|<>|<&|>&|&>>?|>[|>]?|<)(.*)$", re.S)


def _proc_subst_path(m: "re.Match[str]") -> str:
    """`<(…)` reads as the fd path bash hands the command; anything else as
    the text it contributes."""
    return "/dev/fd/63" if m.group(0).startswith("<(") else _subst_text(m)


def _proc_subst_texts(body: str, depth: int = 0) -> list[str]:
    """Every text a `<(…)` body may print: its own echo/printf, else what each
    stage of it prints and what each `<(…)` inside it does, since `cat`, `tee`
    and the like pass those through — `<(cat <(echo …))`, `<(echo … | cat)`
    (XERK-1611). Over-reads on purpose: a reader fed too much fails closed.

    Memoised per decision: `_cat_printed` reaches it once per level of a
    `cat <(cat <(…))` nest, and each pass re-splitting every level's body made
    a deep nest 8x slower than without it (XERK-1614)."""
    if _budget is None:
        return _proc_subst_texts_uncached(body, depth)
    return list(_memo("proc", (body, depth),
                      lambda: tuple(_proc_subst_texts_uncached(body, depth))))


def _proc_subst_texts_uncached(body: str, depth: int) -> list[str]:
    # A body with no operator or comment character is one statement: splitting
    # it anyway re-read every level of a deep `cat <(cat <(…))` nest (XERK-1614).
    unwrapped = _unwrap_group(body).strip()
    segments = (_split_segments(unwrapped) if "#" in unwrapped or _SEGMENT_SPLIT.search(unwrapped)
                else [unwrapped] if unwrapped else [])
    printed = _body_printed(body, _reading())[0]
    # One echo/printf prints its words; `echo …; true` does not print `; true`.
    if printed is not None and len(segments) == 1:
        # ...and, a quoted `$(…)` in them left as written: the reader runs it,
        # so `bash <(echo 'a=$(echo rm -rf /); $a')` assigns its output whole,
        # where the spliced text bound `a=rm` (XERK-1649).
        kept = _kept_printed(unwrapped)
        if kept and kept != printed:
            _spend(len(kept))
            return [printed, kept]
        return [printed]
    if depth >= _MAX_EXPAND_DEPTH:
        return []
    out = []
    # The statements' texts with quoted `$(…)` kept, joined as the reader gets
    # them: `<(echo 'a=$(…)'; echo '$a')` binds across lines (XERK-1649).
    stmts = [_unwrap_group(seg) for seg in segments]
    if any(map(_kept_printed, stmts)):
        out.append("\n".join(filter(None, (_kept_printed(st) or _printed_text(st)
                                            for st in stmts))))
        _spend(len(out[-1]))
    for seg in segments:
        seg = _unwrap_group(seg)
        out.append(_printed_text(_sub_substs(seg, _subst_text)) or "")
        for m in _find_substs(seg):
            if m.group(0).startswith("<("):
                out.extend(_proc_subst_texts(_subst_inner(m), depth + 1))
        # ...and what an `eval` or a `sh -c` in it prints: `<(eval echo …)`.
        words = _strip_prefixes(_tokenize(seg))
        if len(words) > 1 and _basename(words[0]) == "eval":
            # bash's eval takes (and drops) `--`.
            args = words[2:] if words[1] == "--" else words[1:]
            out.extend(_proc_subst_texts(" ".join(args), depth + 1))
        elif words and _basename(words[0]) in _SHELL_PROGS:
            script = _shell_c_script(words[1:])
            if script:
                out.extend(_proc_subst_texts(script, depth + 1))
    return [t for t in out if t.strip()]


def _kept_printed(stmt: str) -> str | None:
    """What ``stmt`` prints with every quoted `$(…)`/backtick left as written,
    when that text holds one: its reader runs them (XERK-1649). An escaped
    backtick reads unescaped too, as bash's `echo "\\`…\\`"` prints it."""
    if "$(" not in stmt and "`" not in stmt:
        return None
    kept = _printed_text(stmt)
    if kept is None:
        return None
    kept = kept.replace("\\`", "`")
    return kept if "$(" in kept or "`" in kept else None


def _reads_stdin_script(stage: str, depth: int = 0, fresh: bool = False) -> bool:
    """Whether the command in ``stage`` runs its stdin (or an inherited fd) as
    a SCRIPT: a shell with no `-c` and no script file (`… | sh`, `bash -s`,
    `sh <<< '…'`), `source`/`.` of such a path (`. <(echo …)`), or a shell
    whose `-c` script holds one — the script's commands inherit the shell's
    stdin, so `echo … | bash -c bash` and `bash -c '. /dev/stdin'` run what
    they are fed (XERK-1614). A group or list reads if any command in it
    does: `echo … | (cat | bash)`."""
    if depth > _MAX_EXPAND_DEPTH:
        return True  # a reader fed too much fails closed
    # Read as bash forms its names first: `_unwrap_group` takes `{,bash}` for
    # a group and leaves `,bash` (XERK-1629). Once per script TEXT — the top,
    # and each ``fresh`` `-c` script, whose quoted braces the outer reading
    # left alone — never per group level: that doubled the work per level
    # (the brace cap re-forms each).
    if depth and not fresh:
        return _reads_stdin_script_as(stage, depth)
    return any(_reads_stdin_script_as(text, depth) for text in _name_readings(stage))


def _reads_stdin_script_as(stage: str, depth: int) -> bool:
    # A part equal to the stage is read as one command, never split again: the
    # redirect re-reading returns `>&1` among the parts of `>&1` (XERK-1616),
    # and re-splitting it ran to the depth cap, which says "reads".
    whole = stage.strip()
    for part in _split_on_operators(_unwrap_group(stage), keep_redirects=True, groups=True):
        core = _group_core(part) if part == whole else part
        if (_command_reads_stdin(part, depth) if core is None or core == whole
                else _reads_stdin_script(core, depth + 1)):
            return True
    return False


# Words that may stand before a group without being its command, and the
# redirections that may follow one: `do (…)`, `! (…)`, `time -p { …; }`,
# `(…) 2>&1`.
_GROUP_LEAD_RE = re.compile(r"\A(?:(?:do|then|else|elif|if|while|until|time|!|-p)[ \t\n]+)+")
# The leads that are NOT themselves compound openers, so a compound behind them
# (`time if …; fi`) is reached without eating its `if`/`while`/`until` opener.
_NONCOMPOUND_LEAD_RE = re.compile(r"\A(?:(?:do|then|else|elif|time|!|-p)[ \t\n]+)+")
_TRAIL_OPS = ("<<<", "<<-", "<<", "&>>", ">>", "&>", ">&", "<&", ">|", "<>", ">", "<")
_TRAIL_WORD_END = frozenset(" \t\n;&|()<>")


def _only_redirects(text: str, i: int) -> bool:
    """Whether ``text[i:]`` is nothing but redirections (`2>&1`, `>f`, `{fd}>f`,
    `<<<w`, `<>f`, a heredoc's `<<EOF`, glued or not, quoted targets too). One greedy pass, as bash reads them: a regex for
    this backtracked over every way to split `>a1>a1…` — exponential, past the
    hook timeout, which fails open (XERK-1614)."""
    n = len(text)
    while True:
        while i < n and text[i] in " \t":
            i += 1
        if i >= n:
            return True
        if text[i] == "{":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            if j == i + 1 or j >= n or text[j] != "}":
                return False
            i = j + 1
        else:
            while i < n and text[i].isdigit():
                i += 1
        op = next((o for o in _TRAIL_OPS if text.startswith(o, i)), None)
        if op is None:
            return False
        i += len(op)
        while i < n and text[i] in " \t":
            i += 1
        start = i
        while i < n and text[i] not in _TRAIL_WORD_END:
            # A quoted span is part of the word, blanks and all: `2>'a b'`. An
            # unclosed quote is read as a plain character, as before quotes were
            # read at all, so reading them never opens fewer groups (XERK-1614).
            if text[i] == "'":
                close = text.find("'", i + 1)
                if close >= 0:
                    i = close
            elif text[i] == '"':
                # ...where a backslash escapes the next character: `"a\"b"`.
                j = i + 1
                while j < n and text[j] != '"':
                    j += 2 if text[j] == "\\" else 1
                if j < n:
                    i = j
            elif text[i] == "\\":
                i += 1
            i += 1
        if i == start:
            return False


def _group_close(core: str) -> int:
    """Index of the closer matching the `(`/`{` group at ``core[0]``, or -1.

    A quote-aware forward scan, as bash reads it: a closer inside `'…'`/`"…"`/
    backticks, escaped (`\\)`), or held in a redirect target (`2>"/tmp/x )))))"`)
    is not the group's (XERK-1628). Replaces a reverse search of the last few
    closers, which a quoted or nested one defeated. `$(`/`${` and nested
    `(`/`{` push their own closer so a `)`/`}` inside them is skipped; a `{` is
    a command group only before a blank, and a group `}` only after one, so
    `${x}` and `{fd}>f` inside the body are text."""
    stack = ["P"] if core[0] == "(" else ["B"]  # P:( p:$( B:{ b:${
    i, n, quote = 1, len(core), None
    while i < n:
        ch = core[i]
        if quote:
            if ch == "\\" and quote != "'" and i + 1 < n:
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            continue
        if core.startswith("$(", i):
            stack.append("p")
            i += 2
            continue
        if core.startswith("${", i):
            stack.append("b")
            i += 2
            continue
        if ch == "(":
            stack.append("P")
        elif ch == "{" and core[i + 1:i + 2] in (" ", "\t", "\n"):
            stack.append("B")
        elif ch == ")" and stack[-1] in ("P", "p"):
            stack.pop()
            if not stack:
                return i
        elif ch == "}" and (stack[-1] == "b"
                            or (stack[-1] == "B" and core[i - 1] in " \t\n;")):
            stack.pop()
            if not stack:
                return i
        i += 1
    return -1


def _group_core(part: str) -> str | None:
    """The group ``part`` runs once its leading keywords and trailing
    redirections are dropped, or None. `_unwrap_group` opens only a group that
    IS the segment, and a group-aware split keeps `do (true; echo …)` whole,
    so the producer inside was never read (XERK-1614).

    A compound command (`if …; then …; fi`, `for/while/until … done`,
    `case … esac`) returns its inner commands with the skeleton keywords
    dropped, so the producer or reader inside is read (XERK-1628)."""
    stripped = part.strip()
    # Before stripping leading keywords: `if`/`while`/`until` are group-lead
    # keywords too (`if (…)`), so `_GROUP_LEAD_RE` would eat the opener.
    if _compound_opener(stripped, 0):
        return _compound_body(stripped)
    # A compound behind a `time`/`!`/`do` keyword prefix (`time if …; fi | sh`);
    # strip only non-opener leads so the `if`/`while`/`until` opener survives.
    led = _NONCOMPOUND_LEAD_RE.sub("", stripped)
    if _compound_opener(led, 0):
        return _compound_body(led)
    core = _GROUP_LEAD_RE.sub("", stripped)
    if core[:1] in ("(", "{"):
        end = _group_close(core)
        # Blank substitutions in the trailing text first: a `$(…)` in a quoted
        # redirect target (`2>"/tmp/x$(echo ")")"`) holds quotes `_only_redirects`
        # cannot pair (XERK-1628). `_find_substs` pairs them as bash does.
        if end >= 0 and _only_redirects(_sub_substs(core[end + 1:], lambda m: "x"), 0):
            return core[:end + 1]
    return None


_COMPOUND_CONNECTORS = ("then", "elif", "else", "do")


def _compound_body(text: str) -> str:
    """``text`` (a compound command) as its inner statements, joined by `;`,
    for the stdin-feed walk to recurse into (XERK-1628).

    The compound's OWN skeleton — the opener, `then`/`do`/`in`/`elif`/`else`,
    the closer and `case` patterns (`x)`, `;;`) — is dropped; an inner group,
    pipeline or nested compound is kept WHOLE so a `for …; do { echo …; } | sh;
    done` still exposes its `{ … } | sh` to the walk. A plain split would cut
    the inner group, and a group-aware one re-groups the whole compound."""
    kw = _compound_opener(text, 0)
    if not kw:
        return text
    n, i = len(text), len(kw)
    stmts: list[str] = []
    buf: list[str] = []
    depth = 0           # inner `(`/`{` groups and nested compounds
    quote: str | None = None
    want_in = kw in ("for", "select", "case")  # a header to skip up to `in`
    # C-style `for ((…)); do …; done` has no `in`; its header is the `((…))`.
    if kw in ("for", "select") and text[len(kw):].lstrip()[:2] == "((":
        want_in = False
    is_case = kw == "case"
    pat = False         # dropping a `case` pattern up to its `)`
    pat_lead = False    # the next non-blank `(` is the optional pattern opener
    pat_paren = 0

    def flush() -> None:
        s = "".join(buf).strip()
        if s and s not in ("fi", "done", "esac"):
            stmts.append(s)
        buf.clear()

    while i < n:
        ch = text[i]
        if quote:
            if not pat:
                buf.append(ch)
            if ch == "\\" and quote != "'" and i + 1 < n:
                if not pat:
                    buf.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            if not pat:
                buf.append(ch)
                buf.append(text[i + 1])
            i += 2
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            if not pat:
                buf.append(ch)
            i += 1
            continue
        if pat:
            # Drop a case pattern up to its `)`. A leading `(` is the OPTIONAL
            # pattern-list opener (`(x)`, `(a|b)`), matched by that `)`; it must
            # not be counted, or the pattern never ends (XERK-1628).
            if pat_lead and ch in " \t":
                i += 1
                continue
            if pat_lead and ch == "(":
                pat_lead = False
                i += 1
                continue
            pat_lead = False
            if ch == "(":
                pat_paren += 1
            elif ch == ")":
                if pat_paren:
                    pat_paren -= 1
                else:
                    pat = False
            i += 1
            continue
        if want_in:
            if depth == 0 and _word_at(text, i, "in") and text[i - 1:i] in (" ", "\t", "\n"):
                want_in = False
                buf.clear()  # the `for X`/`case W` header is not a command
                if is_case:
                    pat = pat_lead = True
                i += 2
                continue
            i += 1  # still in the header
            continue
        if ch == "(":
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if (ch == "{" and text[i + 1:i + 2] in (" ", "\t", "\n")
                and _char_before(text, i) in ("", "{", "(", ";", "&", "|", "\n")):
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch == ")" and depth > 0:
            depth -= 1
            buf.append(ch)
            i += 1
            continue
        if ch == "}" and depth > 0 and text[i - 1:i] in (" ", "\t", "\n", ";"):
            depth -= 1
            buf.append(ch)
            i += 1
            continue
        closer = ("fi" if _word_at(text, i, "fi") else "done" if _word_at(text, i, "done")
                  else "esac" if _word_at(text, i, "esac") else "")
        if closer and _compound_closes(text, i, closer):
            if depth > 0:
                depth -= 1
                buf.append(closer)
                i += len(closer)
                continue
            flush()  # the outer closer ends the compound
            break
        if depth == 0:
            nested = _compound_opener(text, i)
            if nested:
                depth += 1
                buf.append(nested)
                i += len(nested)
                continue
            if is_case and text.startswith(";;", i):
                flush()
                pat = pat_lead = True
                i += 3 if text.startswith(";;&", i) else 2
                continue
            if text.startswith(("&&", "||"), i):
                flush()
                i += 2
                continue
            if ch in (";", "\n", "&"):
                flush()
                i += 1
                continue
            conn = next((c for c in _COMPOUND_CONNECTORS
                         if _word_at(text, i, c) and _at_command_start(text, i)), "")
            if conn:
                flush()
                i += len(conn)
                continue
        buf.append(ch)
        i += 1
    flush()
    return "; ".join(stmts)


def _walked_pipelines(command: str) -> list[str]:
    """The pipelines the stdin-feed walk reads, each once: split keeping groups
    whole, so `{ echo …; } | sh` stays one pipeline; split the plain way too, as
    before groups were kept, so a group the scan keeps but cannot open (`do (a;
    echo …) | sh`) hides nothing the plain split found; and the pipelines inside
    a group that is a whole pipeline — `{ echo … | (a; bash); }` — down to
    `_MAX_EXPAND_DEPTH` levels (XERK-1614)."""
    out = dict.fromkeys(_split_on_operators(command, include_pipe=False, keep_redirects=True,
                                            groups=True)
                        + _split_on_operators(command, include_pipe=False, keep_redirects=True))
    level = list(out)
    for _ in range(_MAX_EXPAND_DEPTH):
        inner = []
        for pipeline in level:
            core = _group_core(pipeline)
            if core:
                inner += [p for p in _split_on_operators(_unwrap_group(core), include_pipe=False,
                                                         keep_redirects=True, groups=True)
                          if p not in out]
        if not inner:
            break
        out.update(dict.fromkeys(inner))
        level = inner
    return list(out)


def _simple_commands(stage: str, depth: int = 0) -> list[str]:
    """The simple commands in ``stage``, every group and list opened, so a
    producer nested in groups still prints: `{ { echo …; }; } | sh`. One split
    without groups cut a deep nest's braces apart (XERK-1614). Past
    `_MAX_EXPAND_DEPTH` the rest is split the old way."""
    if depth > _MAX_EXPAND_DEPTH:
        return [_unwrap_group(seg) for seg in _split_on_operators(stage, keep_redirects=True)]
    whole = stage.strip()
    out = []
    for part in _split_on_operators(_unwrap_group(stage), keep_redirects=True, groups=True):
        core = _group_core(part) if part == whole else part
        out.extend([part] if core is None or core == whole else _simple_commands(core, depth + 1))
    return out


def _command_reads_stdin(stage: str, depth: int) -> bool:
    """`_reads_stdin_script` for one simple command (no list, no group), in
    every way bash may form its program name (`_name_readings`)."""
    return any(_command_reads_stdin_as(text, depth) for text in _name_readings(stage))


def _command_reads_stdin_as(stage: str, depth: int) -> bool:
    text = _sub_substs(stage, _proc_subst_path)
    # A `<(` left is one the (not paren-aware) split cut off from its `)`:
    # `bash < <(echo hi; echo …)` reaches here as `bash < <(echo hi`.
    if "<(" in text:
        text = text[:text.index("<(")] + "/dev/fd/63"
    tokens = _strip_prefixes(_tokenize(text))
    # `sh<<<'…'` and `bash>/dev/null` tokenise as one word; the program is the
    # part before the redirection (XERK-1629: `>` was kept in the name).
    m = re.search(r"[<>]", tokens[0]) if tokens else None
    if m and m.start():
        tokens = [tokens[0][:m.start()], tokens[0][m.start():], *tokens[1:]]
    if not tokens:
        return False
    prog, rest = _basename(tokens[0]), tokens[1:]
    # Peel a wrapper that execs the shell in place (`flock lk sh`, `ssh h sh`):
    # the shell it runs still inherits the pipeline's stdin.
    seen = 0
    while prog in _EXEC_WRAPPERS and rest and seen < 4:
        inner = _wrapper_command(prog, rest)
        if not inner:
            break
        prog, rest = _basename(inner[0]), inner[1:]
        seen += 1
    if prog == "busybox" and rest and _basename(rest[0]) in _SHELL_PROGS:
        prog, rest = _basename(rest[0]), rest[1:]
    if prog in ("source", "."):
        operands = [t for t in rest if not _REDIRECT_RE.match(t)]
        return bool(operands) and bool(_STDIN_SCRIPT_RE.match(operands[0]))
    if prog == "eval":
        # `eval` runs its joined words as a script that inherits the shell's
        # stdin (`… | eval bash`, `eval '{,bash}'`), and a `$(cat)` in them
        # captures that stdin to BE the script (`eval "$(cat)"`) (XERK-1628).
        # Read off the ORIGINAL stage: `text` already blanked the `$(cat)`.
        raw = [t for t in _strip_prefixes(_tokenize(stage))[1:] if not _REDIRECT_RE.match(t)]
        if raw and raw[0] == "--":
            raw = raw[1:]
        script = " ".join(raw)
        for m in _find_substs(script):
            body = _subst_inner(m)
            # `$(cat)` or `$(</dev/stdin)` captures the inherited stdin as the
            # script bash then runs.
            if m.group(0)[0] in "$`" and (_passes_input(body)
                    or re.match(r"\s*<\s*(/dev/stdin|/dev/fd/0|/proc/self/fd/0)\s*$", body)):
                return True
        return bool(script) and _reads_stdin_script(script, depth + 1, fresh=True)
    if prog == "xargs":
        # `xargs … sh -c` hands the piped text to the shell's `-c` as its
        # SCRIPT (`… | xargs -0 sh -c`); with a script already present the text
        # is only positional params, so that is not a read (XERK-1628). But a
        # replace-string (`-I@`/`-i`/`--replace`) substitutes the text INTO the
        # command, so `-I@ sh -c '@'` IS a read.
        cut, replstr = _xargs_options(rest)
        inner, replace = rest[cut:], bool(replstr)
        if inner and _basename(inner[0]) in _SHELL_PROGS:
            # Its redirections are no words: `xargs -0 sh -c <<< '<cmd>'` has
            # no script but the here-string (XERK-1634).
            r2, k = [], 1
            while k < len(inner):
                redirect = _REDIRECT_RE.match(inner[k])
                if redirect:
                    k += 1 if redirect.group(1) else 2
                else:
                    r2.append(inner[k])
                    k += 1
            return replace or (_shell_c_index(r2) >= 0 and not _shell_c_script(r2))
        return False
    if prog not in _SHELL_PROGS:
        return False
    if _shell_c_index(rest) >= 0:
        script = _shell_c_script(rest)
        # Read the `-c` script off the ORIGINAL stage where the shell is the
        # first word: `text` blanked a `$(cat)` the script's own `eval` needs
        # to be seen reading stdin (`bash -c 'eval "$(cat)"'`, XERK-1628).
        raw_toks = _strip_prefixes(_tokenize(stage))
        if (raw_toks and _basename(raw_toks[0]) == prog
                and _shell_c_index(raw_toks[1:]) >= 0):
            script = _shell_c_script(raw_toks[1:]) or script
        if not script:
            return False
        if _reads_stdin_script(script, depth + 1, fresh=True):
            return True
        # ...and a program word the script names through its own variables, a
        # glob or an alias, read as a heredoc owner's is: `sh -c 'x=bash; $x'`
        # (XERK-1638).
        if "$" in script or "alias" in script or _GLOB_CHARS.search(script):
            defined = _defined_names(script)
            # Only a stage whose program word may not be literal: the script
            # itself was read above, and re-reading every stage of a long one
            # per pipeline stage tripled real decisions.
            stages = [st for st in _split_segments(script)
                      if defined or _NONLITERAL_PROG_RE.match(st)]
            if stages:
                vals = _var_values(script)
                return any(_stage_may_read_stdin(st, vals, defined, checked=True)
                           for st in stages)
        return False
    if prog == "su":
        return True  # its operands name a USER; without `-c` the shell reads stdin
    i = 0
    while i < len(rest):
        tok = rest[i]
        redirect = _REDIRECT_RE.match(tok)
        if redirect:
            i += 1 if redirect.group(1) else 2
            continue
        if tok == "--":
            return i + 1 >= len(rest) or bool(_STDIN_SCRIPT_RE.match(rest[i + 1]))
        if tok in _SHELL_OPTS_WITH_VALUE:
            i += 2
            continue
        if tok[:1] in "-+" and len(tok) > 1:
            if not tok.startswith("--") and "s" in tok[1:]:
                return True  # `-s`: the script is stdin, the rest are $1…
            # `-o`/`-O` take the next token (`bash -euo pipefail`), so it is an
            # option value, not the script file (XERK-1539).
            i += 2 if (not tok.startswith("--") and ("o" in tok[1:] or "O" in tok[1:])) else 1
            continue
        return bool(_STDIN_SCRIPT_RE.match(tok))
    return True


def _herestrings(stage: str) -> list[str]:
    """The words `<<<` feeds the command in ``stage``."""
    out = []
    tokens = _tokenize(stage)
    for i, tok in enumerate(tokens):
        m = re.search(r"<<<(.*)$", tok, re.S)
        if m:
            word = m.group(1) or (tokens[i + 1] if i + 1 < len(tokens) else "")
            if word.strip():
                out.append(word)
    return out


# The most distinct producer texts fed to the shells in one pipeline. A real
# `echo '…' | sh` has one; the cap only bites a pathological chain of many
# DIFFERENT producers, where it costs a miss, never a timeout (XERK-1539).
_FED_TEXT_CAP = 64


def _basename(prog: str) -> str:
    return re.split(r"[\\/]", prog)[-1].lower()


# GNU xargs' long options, True where a value is REQUIRED (attached or the next
# word). `--eof`, `--replace` and `--max-lines` take an OPTIONAL value, which
# must be ATTACHED (`--replace={}`): `xargs --max-lines rm -rf /` runs `rm`.
_XARGS_LONG_OPTS = {
    "--arg-file": True, "--delimiter": True, "--max-args": True, "--max-procs": True,
    "--max-chars": True, "--process-slot-var": True,
    "--null": False, "--eof": False, "--replace": False, "--max-lines": False,
    "--open-tty": False, "--interactive": False, "--no-run-if-empty": False,
    "--verbose": False, "--show-limits": False, "--exit": False,
    "--help": False, "--version": False,
}
# xargs short options taking a REQUIRED value (attached or the next word), and
# those whose OPTIONAL value must be attached (`-i{}`, `-l2`, `-eEOF`). `-i`
# and `-e` taking the next word ate the `rm` of `xargs -i rm -rf {}` and
# reopened the very bypass the `-I` fix closed.
_XARGS_SHORT_VALUE = set("adEILnPs")
_XARGS_SHORT_OPTIONAL = set("eil")


def _xargs_options(rest: list[str]) -> tuple[int, str]:
    """Where xargs' own options end in ``rest`` (the index of its command)
    and the replace-string they set ("" for none). Short options CLUSTER as
    getopt reads them: `-rn 1` is `-r -n 1` and `-0I {}` is `-0 -I {}`, so a
    walk taking a cluster as one word put `1` or `{}` in command position and
    `xargs -rn 1 rm -rf /` classified a program named `1` (XERK-1649)."""
    i, replstr = 0, ""
    while i < len(rest) and rest[i].startswith("-") and len(rest[i]) > 1:
        opt = rest[i]
        i += 1
        if opt == "--":
            break
        if opt.startswith("--"):
            name, eq, val = opt.partition("=")
            # getopt_long takes any unambiguous prefix: `--max-a 1` is `--max-args 1`.
            hits = [n for n in _XARGS_LONG_OPTS if n.startswith(name)]
            name = name if name in _XARGS_LONG_OPTS else hits[0] if len(hits) == 1 else name
            if name == "--replace":
                replstr = val or "{}"
            elif not eq and _XARGS_LONG_OPTS.get(name) and i < len(rest):
                i += 1
            continue
        for k, c in enumerate(opt[1:], 1):
            attached = opt[k + 1:]
            if c in _XARGS_SHORT_VALUE:
                if not attached and i < len(rest):
                    attached = rest[i]
                    i += 1
                if c == "I":
                    replstr = attached
                break
            if c in _XARGS_SHORT_OPTIONAL:
                if c == "i":
                    replstr = attached or "{}"
                break
    return i, replstr


def _shell_c_index(rest: list[str]) -> int:
    """Index of a shell's `-c` flag, however it is spelled.

    Short options combine, so `bash -lc '<cmd>'` and `sh -xc '<cmd>'` carry the
    script in exactly the place `-c` does. Testing for the bare `-c` token alone
    missed every combined spelling — and `bash -lc` is the form a shell actually
    gets invoked with.

    `--` ends options: a `-c` after it is a positional argument, not the flag
    (`sh -s -- -c x` reads stdin), so the scan stops there (XERK-1539).
    """
    for i, tok in enumerate(rest):
        if tok == "--":
            return -1
        if tok == "-c":
            return i
        if tok.startswith("-") and not tok.startswith("--") and "c" in tok[1:]:
            return i
    return -1


def _shell_c_script(rest: list[str]) -> str | None:
    """The script a shell's `-c` runs, or None. Bash takes (and drops) a `--`
    after `-c`, so `bash -c -- '<cmd>'` runs <cmd>, not `--` (XERK-1611)."""
    i = _shell_c_script_index(rest)
    return rest[i] if 0 <= i < len(rest) else None


def _shell_c_script_index(rest: list[str]) -> int:
    """Where `_shell_c_script`'s script sits in ``rest`` (maybe past its end),
    or -1. The script is the first operand after `-c`, so options between
    them are skipped: `bash -c -e '<cmd>'`, `bash -c -o errexit '<cmd>'`
    (XERK-1641)."""
    i = _shell_c_index(rest)
    if i < 0:
        return -1
    i += 1
    while i < len(rest) and rest[i][:1] in "-+" and len(rest[i]) > 1:
        if rest[i] == "--":
            return i + 1
        tok = rest[i]
        i += 2 if (tok in _SHELL_OPTS_WITH_VALUE or (
            tok[1] != "-" and tok[-1] in "oO")) else 1
    return i


def _raw_shell_c_scripts(kept: list[str], depth: int = 0) -> list[str]:
    """Each `-c` script in a segment's unspliced words: the segment's own shell,
    or one an `xargs` or `find -exec` runs (XERK-1649) — only a word in RUNNER
    position, so `xargs echo bash -c '…'` prints it. A double-quoted script's
    escaped backticks are live to the shell it reaches, so `bash -c "a=\\`…\\`"`
    is read with them unescaped too: shlex keeps that `\\` where bash drops it.
    A script that is one `$(echo …)` runs the text it prints, read as
    `_proc_subst_texts` does: `bash -c "$(echo 'a=$(…); $a')"`."""
    if not kept or depth > _MAX_EXPAND_DEPTH:
        return []
    prog = _basename(kept[0])
    if prog in _SHELL_PROGS:
        script = _shell_c_script(kept[1:])
        return [] if script is None else _raw_script_texts(script)
    runs: list[list[str]] = []
    if prog == "xargs":
        runs.append(kept[1 + _xargs_options(kept[1:])[0]:])
    elif prog == "find":
        runs += [kept[i + 1:] for i, t in enumerate(kept)
                 if t in ("-exec", "-execdir", "-ok", "-okdir")]
    return [sc for run in runs for sc in _raw_shell_c_scripts(_strip_prefixes(run), depth + 1)]


def _raw_script_texts(script: str) -> list[str]:
    """`_raw_shell_c_scripts`' readings of one `-c` script."""
    out = [script]
    plain = script.replace("\\`", "`")
    if plain != script:
        _spend(len(plain))
        out.append(plain)
    # A `$(echo …)` anywhere in it splices in the text it prints, quoted
    # `$(…)` kept: `bash -c "true; $(echo 'a=$(…); $a')"`.
    if "$(" in script or "`" in script:
        spliced = _sub_substs(script, _kept_subst_text)
        if spliced not in out:
            _spend(len(spliced))
            out.append(spliced)
    return out


def _kept_subst_text(m: "re.Match[str]") -> str:
    """A `$(…)`/backtick as the text it prints with quoted `$(…)` kept (the
    first such `_proc_subst_texts` reading), else left as written."""
    if m.group(0).startswith(("<(", ">(")):
        return m.group(0)
    return next((t for t in _proc_subst_texts(_subst_inner(m)) if "$(" in t or "`" in t),
                m.group(0))


# How many paths a find/xargs-fed shell is read with one per run. Past it the
# most dangerous-looking ones are kept: an absolute path, shortest first.
_MAX_PER_RUN = 32


def _per_run_operands(operands: list[str]) -> list[str]:
    """The operands a shell fed one path per run is read with (XERK-1636).
    Each run is an expansion of its own, so all of several hundred paths
    false-denied as too large (XERK-1641 QA); one reading binding `$1` to
    every path lost `d="$1"`, `cd "$1"` and `$0`."""
    unique = list(dict.fromkeys(operands))
    if len(unique) <= _MAX_PER_RUN:
        return unique
    # Ranked by the guard's own danger test first: by length alone, a padded
    # spelling of a protected path was ranked out (XERK-1641 QA).
    return sorted(unique, key=lambda o: (_dangerous_target(o) is None,
                                         not o.startswith(("/", "~")), len(o)))[:_MAX_PER_RUN]


def _find_roots(tokens: list[str]) -> list[str]:
    """The paths a `find` invocation walks (its operands before any predicate)."""
    roots = []
    # GNU find's own options come first: `-H`/`-L`/`-P`, `-D <opts>`, `-O<n>`
    # (`find -L / -delete` walks `/`, XERK-1636).
    i = 1
    while i < len(tokens) and (tokens[i] in ("-H", "-L", "-P", "-D")
                               or re.fullmatch(r"-O\d*", tokens[i])):
        i += 2 if tokens[i] == "-D" else 1
    for tok in tokens[i:]:
        if tok.startswith("-") or tok in ("(", ")", "!"):
            break
        roots.append(tok)
    return roots


def _expand_both(command: str, home: bool = True) -> list[tuple[list[str], str]]:
    """`_expand_segments`, and — when a spliced value needed escaping, or an
    expansion was read as escaped — again with every value spliced raw and
    every expansion live (see `_quote_literal`, `_live_dollar`). Neither
    reading is right at every re-parse depth; together they fail closed.

    Assigned values are read as before XERK-1609, and once more as several
    statements print them when that differs (`_assigned_values`), and once
    per taint reading the values have (`_value_taint_readings`).

    A name assigned more than once is also read with each value on its own
    (`_picked`), a reading per value: which assignment a use sees is order
    and control flow, and joined they run only the first (XERK-1621).

    A `'` in a string's `${…}` splits the line differently in bash than in
    zsh or dash (`_quote_states`), so a line holding one is read both ways.

    And with every assigned value resolved through its whole chain, when
    that differs from resolving it once (XERK-1648).

    A `for` list runs its words one per iteration, so a list of several is
    also read once per distinct word with the list cut down to that word
    (`_for_word_lines`, XERK-1647)."""
    out = _expand_readings(command)
    # Only a target can read the kept default, so a line with no command that
    # judges one (a HOME default in heredoc data) is not read twice (QA).
    if (_HOME_DEFAULT_RE.search(command) and not _HOME_KEPT[0]
            and any(_basename(entry[0][0]) in _HOME_TARGET_PROGS for entry in out)):
        _HOME_KEPT[0] = True
        try:
            out = out + _expand_readings(command)
        finally:
            _HOME_KEPT[0] = False
    pwd_assigned = (not _PWD_UNASSIGNED[0] and _PWD_SEEN[0]
                    and _MOVES_RE.search(command) is not None)
    if pwd_assigned:
        _PWD_UNASSIGNED[0] = True
        try:
            out = out + _expand_readings(command)
        finally:
            _PWD_UNASSIGNED[0] = False
    for reading in _home_tilde_readings(command) if home else ():
        out = out + _expand_both(reading)
    if _READINGS_MOST[0] > 1 and _READING_PICK[0] is None:
        # Each reading of a multi-reading op spliced plainly, line-wide
        # (XERK-1664): marker-led, `"…; ${a##+(x)}; …"` kept them all in one
        # word, which no path rule splits.
        try:
            for pick in range(min(_READINGS_MOST[0], _MAX_READING_PICKS)):
                _READING_PICK[0] = pick
                out = out + _expand_readings(command)
        finally:
            _READING_PICK[0] = None
    # A values pass is one reading, again when values print differently, and
    # once per taint reading: sixteen tainted `x=$(…)` made each 9x the cost.
    weight = 1 + bool(_VALUES_DIFFER[0]) + min(_VALUES_TAINT_N[0], _MAX_TAINT_STARTS)
    # ...and once more chained (XERK-1648): a word naming `R=$Q` was empty;
    # and in order (XERK-1660).
    chained = (0,) + ((1,) if _CHAIN_DIFFERS[0] else ()) + ((2,) if _ORDER_DIFFERS[0] else ())
    weight *= len(chained)
    lines, too_large = _for_word_lines(command, weight)
    if too_large:
        return out + [([_TOO_LARGE], command)]
    for line, pick in lines:
        # Values only: the per-value, brace and old-parse passes would
        # multiply the readings by the words (XERK-1647 QA). Their joined
        # readings above still see every word.
        _FOR_PICK[0] = pick
        try:
            for chain in chained:
                _VALUES_CHAINED[0] = chain
                out = out + _expand_values(line)
            if pwd_assigned:
                # ...and with PWD/OLDPWD unassigned: a `cd $d` in the loop
                # reaches each word only here (XERK-1753 QA).
                _PWD_UNASSIGNED[0] = True
                out = out + _expand_values(line)
        finally:
            _FOR_PICK[0] = None
            _VALUES_CHAINED[0] = 0
            _PWD_UNASSIGNED[0] = False
    return out



# A `~` bash expands to $HOME (`~+` to $PWD, `~-` to $OLDPWD, `~N`/`~+N`/`~-N`
# to a `dirs` stack entry): opening a word, or after an assignment's `=` or
# `:`, and followed by a `/` or the word's end. Quotes are not read, so one
# inside a `bash -c '…'` script is found too, and a quote may end one
# (`bash -c 'cd /etc; rm -rf ~+'`); this only adds a reading.
_TILDE_SUFFIX = r"(\+|-|[+-]?[0-9]+)?"
_HOME_TILDE_RE = re.compile(r"(?:(?<=^)|(?<=[\s;&|()<>=:{,`]))~" + _TILDE_SUFFIX
                            + r"(?=[/\s;&|()<>:},`'\"]|$)")
# ...and the word of a `${y:-~/x}`, `${y-~}`, `${y:+~/x}`, `${y:=~}`, `${y:?~}`,
# which bash tilde-expands too. Its own pattern: a lookbehind cannot vary in width.
# A name may be a multi-digit positional (`${10:-~}`).
_PARAM_NAME = r"\$\{(?:[A-Za-z_]\w*|[0-9]+|[@*#?!$-])"
_PARAM_TILDE_RE = re.compile("(" + _PARAM_NAME + r":?[-+=?])~" + _TILDE_SUFFIX + "(?=[/}])")
# What a line holding a directory tilde (`~+`, `~-`, `~1`) has, so it is read
# even when it cannot bind HOME.
_DIR_TILDE_RE = re.compile(r"~[-+0-9]")


def _tilde_name(suffix: str | None, home: bool) -> str:
    """The variable a `~<suffix>` reads (XERK-1696): `~+` is $PWD and `~-`
    $OLDPWD; a `dirs` stack entry (`~1`, `~+1`, `~-1`) is a directory the line
    `cd`/`pushd`ed to, which `_under_cwd` reads `$PWD` as. "" leaves a bare `~`
    as written when the line cannot bind HOME."""
    if suffix == "+":
        return "PWD"
    if suffix == "-":
        return "OLDPWD"
    if suffix:
        return "PWD"
    return "HOME" if home else ""
# ...and the replacement of a `${y/pat/~/x}`, found by `_replacement_tildes`.
_PARAM_REPLACE_RE = re.compile(_PARAM_NAME + "//?")


def _replacement_tildes(text: str) -> list[tuple[int, str]]:
    """Where a `~` (and its `+`/`-`/`N` suffix) opens the replacement word of a
    `${y/pat/…}` in ``text``. The pattern may hold `\\x`, `'…'`, `"…"` and a
    `${…}` (quotes and escapes in it too), as bash allows. Linear: one
    right-to-left pass gives, for each position, where a pattern read from
    there ends; a regex retried at every `${y/` was quadratic, exponential
    once its alternatives overlapped, and one search holds the GIL past the
    hook's deadline, which runs the command (QA)."""
    starts = [m.end() for m in _PARAM_REPLACE_RE.finditer(text)]
    if not starts or "~" not in text:
        return []
    n = len(text)
    # For a body starting at i: next_sq, the closing `'`; next_ansi, the
    # closing `'` of a `$'…'` (escapes read); next_dq, the closing `"` (escapes
    # and a nested `${…}` read); next_brace, the `}` closing a `${…}`. ends[i]:
    # the `/` ending a pattern read from i. -1: none. `step` is where the unit
    # opening at i ends: an escape, a quote, a `${…}`, else one character. A
    # bare `{` is a character: bash closes `${z:-{}` at its first `}`.
    size = n + 3
    next_sq, next_ansi, next_dq = [-1] * size, [-1] * size, [-1] * size
    next_brace, ends = [-1] * size, [-1] * size

    def step(i: int) -> int:
        ch = text[i]
        if ch == "\\":
            return i + 2
        if ch == "'":
            q = next_sq[i + 1]
        elif ch == '"':
            q = next_dq[i + 1]
        elif ch == "$" and text.startswith("$'", i):
            q = next_ansi[i + 2]
        elif ch == "$" and text.startswith("${", i):
            q = next_brace[i + 2]
        else:
            return i + 1
        return q + 1 if q >= 0 else -1

    for i in range(n - 1, -1, -1):
        ch = text[i]
        next_sq[i] = i if ch == "'" else next_sq[i + 1]
        next_ansi[i] = i if ch == "'" else next_ansi[i + 2] if ch == "\\" else next_ansi[i + 1]
        if ch == '"':
            next_dq[i] = i
        elif ch == "\\":
            next_dq[i] = next_dq[i + 2]
        elif ch == "$" and text.startswith("${", i):
            q = next_brace[i + 2]
            next_dq[i] = next_dq[q + 1] if q >= 0 else -1
        else:
            next_dq[i] = next_dq[i + 1]
        if ch == "}":
            next_brace[i], ends[i] = i, -1
            continue
        after = step(i)
        next_brace[i] = next_brace[after] if after >= 0 else -1
        ends[i] = i if ch == "/" else ends[after] if after >= 0 else -1
    out = []
    for start in starts:
        end = ends[start]
        if end < 0 or not text.startswith("~", end + 1):
            continue
        m = _REPLACEMENT_TILDE_RE.match(text, end + 1)
        if m:
            out.append((end + 1, m.group(1) or ""))
    return out


_REPLACEMENT_TILDE_RE = re.compile("~" + _TILDE_SUFFIX + "(?=[/}])")
_BARE_CD_RE = re.compile(r"((?:^|(?<=[\s;&|(){`]))cd)(?=[ \t]*(?:[;&|)}\n`]|$))")
# What a line that may bind HOME holds: the name (`HOM{E,}`, `H\OME`, `H$x`
# with `x=OME`) or an `eval` that can build it.
_HOME_HINT_RE = re.compile(r"HOM|OME|\beval\b")
def _home_tilde_readings(command: str) -> list[str]:
    """``command`` with each `~` read as `$HOME`, `~+` as `$PWD`, `~-` as
    `$OLDPWD` and a `dirs` entry (`~1`, `~+1`, `~-1`) as `$PWD`, when
    the line may bind HOME (`_HOME_HINT_RE`); none if that changes nothing
    (XERK-1685). Bash expands `~` from HOME's CURRENT value, so `HOME=/; rm
    -rf ~/etc` deletes /etc, while `~` alone reads as the session's home.
    Every `~` is spliced, a program's too: telling command position from an
    argument (`rm -rf do ~/etc`, `a=(~/etc)`) needs a parse. A spliced program
    stays literal: `_owner_word_may_be_shell` reads an unassigned `$HOME/…` as
    `~/…`.

    A `~` opening a `${y:-…}` word is read both braced (`${HOME}`: an unbraced
    name ending a default word is not resolved, `${y:-$x}`, XERK-1670) and
    bare (`${y/$z/${HOME}/x}` is not resolved either). Elsewhere bare: a
    braced one is not resolved inside `{a,b}` (XERK-1694)."""
    if "~" not in command and "cd" not in command:
        return []
    home = bool(_HOME_HINT_RE.search(command))
    if not home and not _DIR_TILDE_RE.search(command):
        return []

    def splice(m: "re.Match[str]") -> str:
        name = _tilde_name(m.group(1), home)
        return "$" + name if name else m.group(0)

    out = _HOME_TILDE_RE.sub(splice, command)
    if home:
        # ...and a bare `cd`, which goes to $HOME: `HOME=/; cd; rm -rf etc`.
        out = _BARE_CD_RE.sub(r"\1 $HOME", out)
    readings = [out]
    if "${" in out:
        spots = [(m.end(1), m.group(2) or "") for m in _PARAM_TILDE_RE.finditer(out)]
        spots += _replacement_tildes(out)
        if spots:
            def param(form: str) -> str:
                pieces, last = [], 0
                for at, suffix in sorted(spots):
                    word = _tilde_name(suffix, home)
                    if word:
                        pieces += (out[last:at], form % word)
                        last = at + 1 + len(suffix)
                pieces.append(out[last:])
                return "".join(pieces)
            readings = [param("${%s}"), param("$%s")]
    return [r for r in dict.fromkeys(readings) if r != command]


# How many characters of line the per-word `for` readings may re-read in one
# decision (`_for_word_lines`), each weighted by its passes. Characters, not
# time: a wall clock denied a real command on a busy host only (XERK-1647 QA);
# `_MAX_DECIDE_SECONDS` still bounds the whole decision. Each reads
# the WHOLE line less its list: a loop read alone lost what the line set up
# before it (`x=…; for v in a eval; do $v "$x"`) or took out of it through
# another name (XERK-1647 QA). Past this the line is too large (a deny, before
# reading any of them) — a line of hundreds of loops, or a long list beside a
# very long body.
_MAX_FOR_WORD_CHARS = 768 * 1024
# The most readings two glued lists' product may add (`_for_word_lines`): each
# is a whole-line values pass, ~2 ms, and 60 × 60 words took 8 s. Past it the
# line is too large (a deny); real loops gluing two names are a few words each.
_MAX_FOR_PRODUCT = 256


_ForPick = tuple[tuple[str, int], ...]


@_budgeted
def _for_word_lines(command: str, weight: int) -> tuple[list[tuple[str, _ForPick]], bool]:
    """``command`` once per distinct word of each `for` list, that list
    replaced by the word alone, with the `_FOR_PICK` to read it under; and
    whether there were too many to read. Joined, `for v in a 'rm -rf /'; do
    $v; done` read program `a` (XERK-1647); a reading per word with the whole
    list re-read was quadratic in it. One loop at a time, except two lists
    whose names are glued in one word (`$a$b`), read as their product: one at
    a time, `for a in x r; do for b in y m; do $a$b …` never read `rm`
    (XERK-1657). A one-word list too: another binding of its name was joined
    in. Each line is charged its length times ``weight``, the passes
    `_expand_values` makes over it."""
    return _memo("vals", ("for", command, weight), _for_word_lines_of, command, weight)


def _for_word_lines_of(command: str, weight: int) -> tuple[list[tuple[str, _ForPick]], bool]:
    lines: list[tuple[str, _ForPick]] = []
    seen: set[tuple[str, _ForPick]] = set()
    left = _MAX_FOR_WORD_CHARS
    nth: dict[str, int] = {}
    # As `_var_values` reads it: a `\<newline>` in a list is no word of it.
    command = _join_continuations(command)
    read = []
    for name, start, end, words, shell in _for_lists(command):
        nth[name] = nth.get(name, -1) + 1
        # `'$'v` / `"$"v` count: an `eval` joins them into `$v` (XERK-1657).
        if not shell or not re.search(r"\$['\"]*\{?!?['\"]*" + name + r"\b", command):
            # No `do`, or never expanded, so no word of it runs: most such
            # lists are another language's `for` in a quoted or heredoc
            # script, and read per word a 10 KB Python heredoc was too
            # large, its words cut out of their quoting too deep (QA).
            continue
        read.append((name, nth[name], start, end, list(dict.fromkeys(words))))
    picks = [(((name, k),), ((start, end, word),))
             for name, k, start, end, words in read for word in words]
    where: dict[frozenset[str], list[int]] = {}
    glued = _glued_name_groups(command, {r[0] for r in read if len(r[4]) > 1}, where)
    lists: dict[str, list[int]] = {}  # each name's lists, by index into `read`
    for i, r in enumerate(read):
        if len(r[4]) > 1:
            lists.setdefault(r[0], []).append(i)
    # Largest first: a group inside a kept one is already read by its product.
    kept: list[frozenset[str]] = []
    for group in sorted(glued, key=lambda g: (-len(g), sorted(g))):
        if not any(group <= k for k in kept):
            kept.append(group)

    def nearest(group: frozenset[str], at: int) -> tuple:
        # Each name's last list starting before the word: the loop that binds
        # it there. None before it (a function body read later): all of them.
        return tuple(tuple(i for i in lists[n] if read[i][2] < at)[-1:] or tuple(lists[n])
                     for n in sorted(group))

    # Every list of each name against every other's, as two names always
    # were; past the cap, only the lists binding each glued word, so the same
    # names looped again and again (eight copies of a test rig) stay readable.
    for mode in ("all", "near"):
        combos = dict.fromkeys(
            combo for group in kept
            for per in ([tuple(tuple(lists[n]) for n in sorted(group))] if mode == "all"
                        else dict.fromkeys(nearest(group, at) for at in where[group]))
            for combo in itertools.product(*per))
        products = 0
        for combo in combos:
            products += math.prod(len(read[i][4]) for i in combo)
            if products > _MAX_FOR_PRODUCT:
                break
        else:
            break
    else:
        if _budget is not None:
            _budget["capped"] = True
        return [], True
    for combo in combos:
        rs = [read[i] for i in combo]
        picks += [(tuple((r[0], r[1]) for r in rs), tuple((r[2], r[3], w) for r, w in zip(rs, words)))
                  for words in itertools.product(*(r[4] for r in rs))]
    for pick, spans in picks:
        line = command
        for start, end, word in sorted(spans, reverse=True):
            line = line[:start] + word + line[end:]
        entry = (line, pick)
        if entry in seen:
            continue
        left -= len(line) * weight
        if left < 0:
            # Recorded on the decision, as `_expand_picks`'s cap is.
            if _budget is not None:
                _budget["capped"] = True
            return [], True
        seen.add(entry)
        lines.append(entry)
    return lines, False


def _glued_name_groups(command: str, names: set[str],
                       where: dict[frozenset[str], list[int]] | None = None) -> set[frozenset[str]]:
    """Each set of ``names`` whose values one word may join, as a product of
    their values may form it: used in one word (`$a$b`, `${a}a$b`, `$a$z$b`,
    `$a$b$c`, XERK-1657 QA), or through a name that holds them (`c=$a; $c$b`,
    `printf -v c %s%s $a $b; $c`, `f(){ $1$2; }; f $a $b`, XERK-1692;
    `_glue_sources`). Not across a `/` (`$d/$f`): read per path, real loops
    over directories cost 2x for a shape that forms no program word. Each
    group's word starts are added to ``where``."""
    if len(names) < 2:
        return set()
    src = _glue_sources(command, names)
    groups: set[frozenset[str]] = set()
    run: set[str] = set()
    last = start = None

    def close() -> None:
        if len(run) > 1:
            groups.add(frozenset(run))
            if where is not None:
                where.setdefault(frozenset(run), []).append(start)

    for use in _GLUE_USE_RE.finditer(command):
        got = src.get(use.group(1))
        if not got:
            continue  # another name may be empty: `$a$z$b`
        if last is None or not re.fullmatch(r"[^\s;|&<>()/]*", command[last:use.start()]):
            close()
            run, start = set(), use.start()
        run |= got
        last = use.end()
    close()
    return groups


def _glue_sources(command: str, names: set[str]) -> dict[str, frozenset[str]]:
    """Each name mapped to the ``names`` (loop names) its value may hold:
    a loop name itself; a name assigned a word using one (`c=$a`, `c=" $a"`,
    `c=$(echo $a)`), rendered or read from one (`printf -v c FMT $a $b`,
    `read c <<< $a`); a positional `$N` a
    `set` or a call of a function the line defines passes one in (`f $a $b`;
    with a `shift` on the line, any later argument too). Lexical and
    order-blind: an extra source only adds product readings (capped); one
    missed is a product never read."""
    def uses(text: str) -> set[str]:
        return {u.group(1) for u in _GLUE_USE_RE.finditer(text)}

    edges: list[tuple[str, set[str]]] = []
    for m in _GLUE_ASSIGN_RE.finditer(command):
        if m.group(1):
            edges.append((m.group(1), uses(m.group(2))))
        elif m.group(3):
            edges.append((m.group(3), uses(m.group(4))))
        else:
            got = uses(m.group(6))
            edges += [(w, got) for w in m.group(5).split() if _GLUE_NAME_RE.fullmatch(w)]
    if _GLUE_POS_RE.search(command):
        shifts = bool(_GLUE_SHIFT_RE.search(command))
        lists = [m.group(1) for m in _GLUE_SET_RE.finditer(command)]
        funcs = {m.group(1) or m.group(2) for m in _FUNC_NAME_RE.finditer(command)} - {None}
        if funcs:
            call_re = re.compile(_CALL_LEAD + r"(?:" + "|".join(map(re.escape, funcs))
                                 + r")[ \t]+([^;&|\n`)]*)")
            lists += [m.group(1) for m in call_re.finditer(command)]
        for text in lists:
            for k, word in enumerate(_call_words(text)[:9], 1):
                got = uses(word)
                # A `shift` moves a later argument down to `$k`.
                edges += [(str(j), got) for j in (range(1, k + 1) if shifts else (k,))]
    # A loop name holds its list's word: a `v=$1` elsewhere (a heredoc
    # script's) made every `rf-$v` a product (replayed false deny).
    edges = [(t, u) for t, u in edges if u and t not in names]
    # Propagated along a worklist: a name's sources grow at most once per
    # loop name, so a chain of any length or order settles in linear work.
    src: dict[str, frozenset[str]] = {n: frozenset((n,)) for n in names}
    readers: dict[str, list[int]] = {}
    for i, (_, used) in enumerate(edges):
        for u in used:
            readers.setdefault(u, []).append(i)
    work = [i for n in names for i in readers.get(n, ())]
    while work:
        target, used = edges[work.pop()]
        before = src.get(target, frozenset())
        got = before.union(*(src.get(u, ()) for u in used))
        if got != before:
            src[target] = got
            work += readers.get(target, ())
    return src


# A use `_glued_name_groups` reads: `$a`, `${a}`, `'$'a` (an eval joins it),
# and a positional `$1`.
_GLUE_USE_RE = re.compile(r"\$['\"]*\{?!?['\"]*([A-Za-z_]\w*|[1-9])['\"]*\}?")
_GLUE_NAME_RE = re.compile(r"[A-Za-z_]\w*")
# A value `_glue_sources` follows: `c=WORD` (quoted runs, `$(…)` and
# backticks in it, each bounded so a run of unclosed `$(` stays linear),
# `local c=WORD`; `printf -v c` to the end of its command;
# `read NAMES <<< WORD`. A nameref is not followed (XERK-1722).
_GLUE_ASSIGN_RE = re.compile(
    r"(?<![\w$])([A-Za-z_]\w*)\+?=((?:\"[^\"]*\"|'[^']*'|\$\([^)\n]{0,256}\)|`[^`\n]{0,256}`|[^\s\"'`;&|])*)"
    r"|(?<![\w.-])printf[ \t]+-v[ \t]*['\"]?([A-Za-z_]\w*)['\"]?([^;&|\n]*)"
    r"|(?<![\w.-])read((?:[ \t]+[^\s;&|<>]+)*)[ \t]*<<<[ \t]*([^\s;&|]+)")
_GLUE_POS_RE = re.compile(r"\$\{?[1-9]")
_GLUE_SHIFT_RE = re.compile(r"(?<![\w.-])shift\b")
# A `set` binding positionals: `set -- WORDS`, `set WORDS`.
_GLUE_SET_RE = re.compile(r"(?<![\w.-])set[ \t]+(?:-[\w-]*[ \t]+)*([^;&|\n`)]*)")


def _expand_readings(command: str) -> list[tuple[list[str], str]]:
    """`_expand_both` for one line: the readings its values and quoting need."""
    out = _expand_picks(command)
    assigned = _default_assignments(command)
    if assigned:
        # `${x:=word}` assigns word to an unset x, which a later `$x` runs:
        # `: ${x:='rm …'}; eval "$x"` (XERK-1634). An ADDED reading with each
        # one written out as an assignment first; folded into the values, it
        # shadowed the default at the `${…}` itself and the name's own value.
        out = out + _expand_picks(assigned + command)
    if _BRACE_OTHER_SEEN[0]:
        _BRACE_OTHER_SHELL[0] = True
        try:
            out = out + _expand_picks(command)
        finally:
            _BRACE_OTHER_SHELL[0] = False
    if _BRACE_QUOTED_SEEN[0] and not _BRACE_QUOTED[0]:
        _BRACE_QUOTED[0] = True
        try:
            out = out + _expand_picks(command)
        finally:
            _BRACE_QUOTED[0] = False
    if _MAIN_PARSE_SEEN[0] or _BRACE_OTHER_SEEN[0]:
        _MAIN_PARSE[0] = True
        try:
            out = out + _expand_values(command)
        finally:
            _MAIN_PARSE[0] = False
    # Every value resolved through its whole chain, and in order, per value
    # too (`_assigned_values`): added readings, as the others are.
    for mode, differs in ((1, _CHAIN_DIFFERS[0]), (2, _ORDER_DIFFERS[0])):
        if differs:
            _VALUES_CHAINED[0] = mode
            try:
                out = out + _expand_picks(command)
            finally:
                _VALUES_CHAINED[0] = 0
    if _PRINTED_DROP_SEEN[0] and not _PRINTED_DROP[0]:
        _PRINTED_DROP[0] = True
        try:
            out = out + _expand_picks(command)
        finally:
            _PRINTED_DROP[0] = False
    if _READINGS_SEEN[0] and not _READINGS_JOINED[0]:
        # An op's readings in `"…"` as one word too (`_splice_readings`), in
        # every reading above: one assignment away, only the chained one
        # resolves `s="$y …"` (XERK-1673 QA).
        _READINGS_JOINED[0] = True
        try:
            out = out + _expand_readings(command)
        finally:
            _READINGS_JOINED[0] = False
    return out


def _default_assignments(command: str) -> str:
    """Each `${x:=word}` / `${x=word}` on the line as `x=word` statements."""
    if "=" not in command or "${" not in command:
        return ""
    out = []
    for m in _ASSIGN_DEFAULT_RE.finditer(command):
        close = _brace_end(command, m.start())
        if close > m.end():
            out.append(f"{m.group(1)}={command[m.end():close]}\n")
    _spend(sum(map(len, out)))
    return "".join(out)


# The most name × value combinations `_expand_picks` reads, and a use of a
# name in program position (or eval'd) that makes them worth reading.
_MAX_CROSS_PASSES = 8
_PROGRAM_USE = r"(?:^|[;&|\n(){{}}`]|\b(?:then|do|else|eval|exec|command))[ \t\"']*\$\{{?{}\b"


def _expand_picks(command: str) -> list[tuple[list[str], str]]:
    """`_expand_values`, and once per value of a name assigned more than once
    (see `_expand_both`)."""
    out = _expand_values(command)
    most = _VALUES_MOST[0]
    # Assignments are capped, and so are the readings applied defaults add:
    # each is a whole-line expansion, and 16 names × 16 `x=${D:-…}` ran 30s.
    if _VALUES_ASSIGNED[0] > _MAX_VALUE_READINGS or most > _MAX_VALUE_PASSES:
        # Recorded on the decision, as a spent budget is: `decide` must
        # refuse it whichever reason it meets first (see there).
        if _budget is not None:
            _budget["capped"] = True
        return out + [([_TOO_LARGE], command)]
    for k in range(most if most > 1 else 0):
        _VALUE_PICK[0] = k
        try:
            out = out + _expand_values(command)
        finally:
            _VALUE_PICK[0] = None
    # Same-index passes pair every name's k-th value, so `c='rm …'; p=true;
    # p=bash; $p -c "$c"; c=ls` never read `bash` with `rm …`. Each name's
    # values against the others' too, while the combinations fit the pass cap
    # (XERK-1634); past it, the same-index passes above are all there is.
    # Only where a value can be a PROGRAM (`$p -c "$c"`, `eval "$p …"`): every
    # extra pass is a whole-line expansion, and 23 of them timed real lines out.
    multi = sorted((n, c) for n, c in _VALUE_COUNTS.items() if c > 1)
    if (len(multi) > 1 and math.prod(c for _, c in multi) <= _MAX_CROSS_PASSES
            and any(re.search(_PROGRAM_USE.format(re.escape(n)), command) for n, _ in multi)):
        for combo in itertools.product(*(range(c) for _, c in multi)):
            if len(set(combo)) == 1:
                continue  # a same-index pass already read it
            _VALUE_PICK[0] = tuple(zip((n for n, _ in multi), combo))
            try:
                out = out + _expand_values(command)
            finally:
                _VALUE_PICK[0] = None
    return out


def _expand_values(command: str) -> list[tuple[list[str], str]]:
    """`_expand_raw_too`, and again with values read as several statements
    print them, and per taint reading, when those differ (see `_expand_both`).
    Per value too: on the all-values pass alone, `a=true; a=$(false || echo
    rm … | grep .); $a` never read the tainted value as the program."""
    out = _expand_raw_too(command)
    if _VALUES_DIFFER[0]:
        _VALUES_MULTI[0] = True
        try:
            out = out + _expand_raw_too(command)
        finally:
            _VALUES_MULTI[0] = False
    k = 0
    while k < min(_VALUES_TAINT_N[0], _MAX_TAINT_STARTS):
        _VALUES_TAINT[0] = k
        try:
            out = out + _expand_raw_too(command)
        finally:
            _VALUES_TAINT[0] = -1
        k += 1
    return out


_SCRIPT_READERS = _SHELL_PROGS | {"eval", "source", "."}


# A closer on a heredoc's line means the heredoc may be a compound command's
# redirect, which feeds every command in it: `(…)<<EOF`, `{ …; } 2>&1 <<EOF`,
# `fi <<EOF`, `done >|f <<EOF`, `esac <<EOF`.
_GROUP_CLOSER_RE = re.compile(r"[)}]|(?<![\w.-])(?:fi|done|esac)(?![\w.-])")


def _ungrouped(segment: str) -> tuple[str, ...]:
    """``segment`` without the group marks a split left on it, read two ways:
    trimmed at its ends (`(bash`, `{ bash`, `X=$(pwd) bash)`) and cut at its
    first closer (`(bash)<<EOF`, `(bash){fd}>f`). Neither knows quoting, so
    each alone lost a shape the other reads; either counts. Only for asking
    which program it runs."""
    seg = segment.strip().lstrip("({ \t")
    cuts = [i for i in (seg.find(")"), seg.find("}")) if i >= 0]
    return tuple(dict.fromkeys([seg.rstrip(");} \t")]
                               + [seg[:i].rstrip("; \t") for i in cuts]))


# A shell named anywhere on a line, as a word: `/bin/sh`, `X=')' bash`.
_SHELL_WORD_RE = re.compile(
    r"(?<![\w.-])(?:bash|sh|zsh|ksh|dash|ash|hush|msh|busybox|su|eval|source)(?![\w.-])"
    r"|(?:^|(?<=[\s;&|({]))\.(?=\s)")


# What may expand to nothing inside a word: `$@`, `$*`, `${@:-}`, `${*:1}` (no
# arguments at the top level) and an empty `$''` / `$""`.
# `${@:-w}` / `${*-w}` is `w` (`${@:=w}` is an error). `[^}$]`, not `[^}]`: that restarted at every
# unclosed `${@`, quadratic.
_EMPTY_EXPANSION_RE = re.compile(r"\$(?:[@*]|\{[@*](?::?-([^}$]*)|[^}$]*)\}|''|\"\")")
# `$"…"` is a locale-translated string: untranslated, `$"bash"` runs `bash`.
_LOCALE_STRING_RE = re.compile(r"\$(?=\")")


def _name_readings(text: str) -> tuple[str, ...]:
    """``text``, and again as bash may form program names from it (XERK-1629):
    every `$(…)`/backtick substitution printing nothing, `$@`/`$*`/`$''`/`$""`
    empty, `$'\\x68'` decoded and `{a,b}` braces expanded. Bash runs `bas``h`,
    `bas$(:)h`, `bas$@h`, `$'bas\\150'`, `$"bash"` as `bash`, and `{bas,-s}h` as `bash
    -sh`; shlex reads each as one other word. Only for asking which program a
    command runs: a substitution dropped here is still classified where it sits."""
    if "$" not in text and "`" not in text and "{" not in text:
        return (text,)
    out, last = [], 0
    for m in _find_substs(text):
        if m.group(0)[0] in "$`":
            out.append(text[last:m.start()])
            last = m.end()
    out.append(text[last:])
    formed = _LOCALE_STRING_RE.sub("", _EMPTY_EXPANSION_RE.sub(lambda m: m[1] or "",
                                                               "".join(out)))
    formed = _expand_braces(_decode_ansi_c(formed))
    return (text,) if formed == text else (text, formed)


def _reads_stdin_grouped(segment: str) -> bool:
    return any(_reads_stdin_script(text) for text in _ungrouped(segment))


# Substitution bodies that print nothing, unless the line redefines them.
_SILENT_BODIES = {"", ":", "true", "false"}


def _owner_substs(text: str) -> str:
    """``text`` with each complete substitution replaced by a placeholder:
    `` `0` `` for a body that prints nothing (`$(:)`), `` `s` `` for any
    other. Printed text is never trusted — IFS splits it, `echo` may be
    redefined, and `en$(…)` printing `v bash` runs `env bash` — so
    `_owner_word_may_be_shell` fails closed on `` `s` `` (XERK-1624)."""
    # Idempotent: a placeholder already in ``text`` maps to itself.
    return _sub_substs(text, lambda m: "`0`" if _subst_inner(m).strip() in (*_SILENT_BODIES, "0")
                       else "`s`")


# A heredoc operator and its delimiter word (not a `<<<` here-string).
# The delimiter is a whole shell word: `'EOF'x`, `E'O F'`, `E\\ F` (QA).
_HEREDOC_OP_RE = re.compile(
    r"""\d*(?<!<)<<-?(?!<)\s*(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s;&|<>()'"\\])+""", re.S)


def _heredoc_segment_programs(segment: str):
    """The program words a segment holding a heredoc operator may run: `bash`
    for `bash<<EOF` (one shlex word), `(bash <<EOF`, `(bash)<<EOF`, `x=1
    bash<<-EOF`, `<<EOF bash` and `x=$(bash <<EOF`, one per reading. Words come
    back as written (`/bin/ba?h`, `$b`); `_owner_word_may_be_shell` reads them."""
    # A substitution still open on this line is where the heredoc's command
    # starts: `echo "$(bash<<EOF`, `cat <(sh <<EOF`. A closed one stays a word
    # of its own, so `$(echo bash)<<EOF` still names a program (XERK-1624).
    text = re.split(r"[$<>]\(", _owner_substs(segment))[-1]
    # ...and the text as written: `_ungrouped` strips a `{` glued to the word,
    # and bash reads `{f` or `{{` as a function's whole name.
    readings = [text.strip(), *_ungrouped(text)]
    # ...and with each heredoc operator and its delimiter dropped: glued on,
    # `env<<'E' bash` read the wrapper as the program and never stripped it
    # to `bash` (XERK-1661 QA). An added reading.
    unglued = _HEREDOC_OP_RE.sub(" ", text).strip()
    if unglued != readings[0]:
        readings += [unglued, *_ungrouped(unglued)]
    for reading in dict.fromkeys(readings):
        tokens = _strip_prefixes(_tokenize(reading))
        # A redirection may come first, and its target may be a word of its own.
        while tokens and re.match(r"\d*[<>]", tokens[0]):
            tok = tokens.pop(0)
            if tokens and re.fullmatch(r"\d*(<<-?|<|>>?|[<>]&|&>>?)", tok):
                tokens.pop(0)
        if tokens:
            # A closer glued on stays when a quoted one cut the reading
            # first: `(X=')' /bin/bas[h])<<EOF`.
            yield re.split(r"[<>]", tokens[0], maxsplit=1)[0].rstrip(");}")


# A function or alias the command defines: `f() {`, `function f {`, `alias b=…`.
# Bash takes nearly any word as a function name (`f+`, `f]`, `f@`), so a name
# is a whole word up to `()`. Both patterns start only at a word's start and
# never restart inside one, so a long word costs one pass, not its square: the
# lookbehind and the name share no character (a `{` opens a group only before
# whitespace, so `{f()` names `{f`, as bash reads it).
_FUNC_NAME_RE = re.compile(
    r"(?:^|(?<=[\s;&|()]))([^\s;&|()<>'\"`$]+)[ \t]*\([ \t]*\)"
    r"|(?<![\w.-])function[ \t]+([^\s();|&]+)")
_ALIAS_RE = re.compile(r"(?<![\w.-])alias([^;&|\n]*)")


# Ways to make ANY program name run something else, which no name check can
# follow: `hash -p /bin/bash cat`, `BASH_ALIASES[b]=bash`, `BASH_CMDS[…]`, and a
# `command_not_found_handle` an unknown name runs (XERK-1638).
_REBIND_RE = re.compile(r"(?<![\w.-])hash[ \t]+(?:-\w+[ \t]+)*-\w*p|BASH_ALIASES|BASH_CMDS"
                        r"|command_not_found_handle")
# In `_defined_names`: every name may be rebound.
_ANY_NAME = "\x00turma-any-name"


def _defined_names(command: str) -> frozenset[str]:
    """Names ``command`` defines as a function or alias, which can run a shell.
    Also read with quotes and escapes dropped, as an `eval` joins them:
    `eval "ali""as b=bash"` defines `b` (XERK-1638)."""
    names: set[str] = set()
    joined = re.sub(r"[\\'\"]", "", command)
    for text in dict.fromkeys((command, joined)):
        names.update(a or b for a, b in _FUNC_NAME_RE.findall(text))
        for words in _ALIAS_RE.findall(text):
            names.update(w.split("=", 1)[0].strip("'\"") for w in words.split() if "=" in w)
        if _REBIND_RE.search(text):
            names.add(_ANY_NAME)
    return frozenset(n.lower() for n in names)


# Off while the line is read with its aliases replaced: `alias ls='ls -l'`
# would otherwise replace itself once per nesting level until "too deep".
_ALIASES_ON = [True]
# Chain hops followed when replacing alias uses.
_ALIAS_HOPS = 3
# A use of the alias NAME as a whole word anywhere: a list of command
# positions kept missing one (`if`, `!`, `coproc`, a leading assignment, a
# value ending in a blank) (XERK-1641 QA). An argument replaced too only adds
# a reading; the definition's own `b=` is no use.
_ALIAS_USE_RE = r"(^|(?<=[^\w./=$-])){}(?![\w./=-])"


def _aliased_readings(command: str) -> list[str]:
    """``command`` with each alias it defines replaced by its value at every
    use, once with each name's first value and once with its last, chains
    followed a few hops."""
    aliases = _alias_values(command)
    out = []
    most = max((len(v) for v in aliases.values()), default=0)
    # Each name's first and last definition: every one was a whole-line
    # reading apiece, and ten redefinitions of a name used 3000 times timed out.
    for k in sorted({0, most - 1}) if most else ():
        text = command
        for _ in range(_ALIAS_HOPS):
            before = text
            for name, values in aliases.items():
                value = values[min(k, len(values) - 1)]
                text = re.sub(_ALIAS_USE_RE.format(re.escape(name)),
                              lambda m: m.group(1) + value, text)
            _spend(len(text) - len(before))
            if text == before:
                break
        if text != command and text not in out:
            out.append(text)
    return out


_ALIAS_NAME_RE = re.compile(r"[^\s/$`=\'\"\\(){}<>|&;]+")


def _alias_values(command: str) -> dict[str, list[str]]:
    """Each alias ``command`` defines, mapped to its values (dequoted)."""
    out: dict[str, list[str]] = {}
    for words in _ALIAS_RE.findall(command):
        if not words[:1].isspace():
            continue  # `alias={…}` in a script's text is no definition
        try:
            toks = shlex.split(words)
        except ValueError:
            toks = words.split()
        for w in toks:
            if "=" in w:
                name, value = w.split("=", 1)
                # A name bash accepts; an empty one matched every word.
                if not _ALIAS_NAME_RE.fullmatch(name):
                    continue
                if value and value not in out.get(name, ()):
                    out.setdefault(name, []).append(value)
    return out


def _function_bodies(command: str) -> dict[str, str]:
    """Each function ``command`` defines, mapped to its body (the `{ … }` or
    `( … )` after the header, unwrapped), so a bare call to it in the stdin
    walk runs that body — `f() { bash; }; echo … | f` (XERK-1628)."""
    bodies: dict[str, str] = {}
    for m in _FUNC_NAME_RE.finditer(command):
        name = m.group(1) or m.group(2)
        if not name:
            continue
        j = m.end()
        while j < len(command) and command[j] in " \t\n":
            j += 1
        # `function f ()` has a `()` the `function NAME` arm did not consume;
        # skip it to reach the `{ … }`/`( … )` body (XERK-1628).
        if m.group(2) and command[j:j + 1] == "(":
            k = j + 1
            while k < len(command) and command[k] in " \t":
                k += 1
            if command[k:k + 1] == ")":
                j = k + 1
                while j < len(command) and command[j] in " \t\n":
                    j += 1
        if j < len(command) and command[j] in ("{", "("):
            end = _group_close(command[j:])
            if end >= 0:
                bodies[_basename(name)] = _unwrap_group(command[j:j + end + 1])
    return bodies


# A shell name starting a value or a path component in it.
_SHELL_PREFIX_RE = re.compile(
    r"(?:^|/)(?:" + "|".join(re.escape(n) for n in sorted(_SCRIPT_READERS)) + ")")


def _owner_word_may_be_shell(word: str, vals: dict[str, list[str]],
                             defined: frozenset[str]) -> bool:
    """Whether program word ``word`` may run a shell (XERK-1624). A literal
    name is checked as written; a non-literal one fails closed unless it
    resolves to something else: `$b` this line assigns is resolved, while an
    unset `$x`, `$SHELL`, a substitution or `$'bas\\x68'` may be any program.
    A glob matching a shell's name (`/bin/ba?h`) and a function or alias the
    line defines (`f() { bash; }`) may be one too, and any name at all on a
    line that rebinds names (`hash -p`, `BASH_ALIASES`, XERK-1638)."""
    if _ANY_NAME in defined:
        return True
    if "`0`" in word:
        # A silent substitution prints nothing — unless `:`/`true`/`false`
        # are redefined on the line — so `cat$(:)` runs `cat`.
        if not defined.isdisjoint(_SILENT_BODIES):
            return True
        word = word.replace("`0`", "")
        if not word:
            return True  # nothing left: the program is the next word
    if "`" in word:
        return True  # unknown output: it may split or form any path
    if "$" in word:
        # `_ungrouped` cuts at the first `}`, even a `${x}`'s: close it again.
        if word.count("${") > word.count("}"):
            word += "}"
        # An unset positional takes its default: `ba${@:-zz}sh` is `bazzsh`.
        word = _substitute_vars(_bind_positionals(word, [None]), vals)
        # HOME is always set: a program under an unassigned `$HOME` is as
        # literal as `~/bin/x` (XERK-1685, where `~` is also read as `$HOME`).
        word = _HOME_LEAD_RE.sub("~", word, count=1)
        # Unresolved, or empty (the program shifts to the next word: `$x bash`).
        if "$" in word or "`" in word or not word.split():
            return True
        # A set IFS splits a value anywhere, so its program may be any prefix
        # of it: `IFS=x; a=bashx-s; $a` runs `bash -s`.
        if "IFS" in vals and (_SHELL_PREFIX_RE.search(word.lower())
                              or any(word.lower().startswith(n) for n in defined)):
            return True
        return any(_owner_word_may_be_shell(w, {}, defined) for w in word.split())
    name = _basename(word)
    # A defined name may hold a `/` (`f/g() { bash; }`), so match it whole too.
    if name in _SCRIPT_READERS or name in defined or word.lower() in defined:
        return True
    if not _GLOB_CHARS.search(name):
        return False
    # Python's fnmatch is not bash's glob: it reads `[^x]` as a literal `^`
    # and has no `[[:alpha:]]` class. Negate as bash does; fail closed on a class.
    if "[:" in name:
        return True
    pattern = name.replace("[^", "[!")
    return any(fnmatch.fnmatchcase(shell, pattern) for shell in _SCRIPT_READERS)


# Only a path UNDER it: a bare `$HOME` program is HOME's value, which a binding
# the values pass misses (`declare H\\OME=/bin/bash`) can make a shell.
_HOME_LEAD_RE = re.compile(r"\A\$(?:HOME|\{HOME\})(?=/)")


# A program word that may not be literal: an expansion, a glob, a substitution.
_NONLITERAL_RE = re.compile(r"[$`*?\[]")
_NONLITERAL_PROG_RE = re.compile(r"[\s({!]*(?:[A-Za-z_]\w*=\S*\s+)*[^\s;|&]*[$`*?\[]")


def _stage_may_read_stdin(stage: str, vals: dict[str, list[str]],
                          defined: frozenset[str], checked: bool = False) -> bool:
    """`_reads_stdin_grouped`, with the program word read as
    `_owner_word_may_be_shell` reads it: `cat <<EOF | $S` (XERK-1624).
    ``checked``: the caller already asked `_reads_stdin_script`."""
    if not checked and _reads_stdin_grouped(stage):
        return True
    stage = _owner_substs(stage)
    for reading in dict.fromkeys((stage.strip(), *_ungrouped(stage))):  # `| {f`, as above
        tokens = _strip_prefixes(_tokenize(reading))
        if not tokens:
            continue
        word = tokens[0]
        if "`0`" in word and not defined.isdisjoint(_SILENT_BODIES):
            return True  # `:`/`true`/`false` redefined: not silent after all
        if "$" in word or "`" in word:
            resolved = _substitute_vars(word.replace("`0`", ""), vals)
            if (resolved.split() and "IFS" not in vals
                    and "$" not in resolved and "`" not in resolved):
                # Resolved to literal words: read the stage they make.
                if _reads_stdin_grouped(_substitute_vars(reading.replace("`0`", ""), vals)):
                    return True
            elif _owner_word_may_be_shell(word, vals, defined):
                return True  # unknown text that may still name a shell
        elif _basename(word) not in _SCRIPT_READERS and _owner_word_may_be_shell(
                word, vals, defined):
            return True  # a glob matching a shell, or a function or alias
    return False


def _line_feeds_shell(raw_commands: str) -> bool:
    """Whether any command on a heredoc-free line may read its stdin as a
    script: `_heredoc_owner_feeds_shell`'s ``commands_feed_shell``."""
    # Quotes, escapes and line continuations joined: bash runs `bas''h`,
    # `b\ash`, `bas$''h` and `bas\` / `h` as `bash`.
    # ...and names formed by an empty substitution or a brace (XERK-1629).
    texts = _name_readings(raw_commands)
    joined = [re.sub(r"\\\n|\$(?=['\"])|[\\'\"]", "", t) for t in texts]
    return any(map(_SHELL_WORD_RE.search, (*texts, *joined))) or any(
        _reads_stdin_grouped(st) for t in texts for st in _split_segments(t))


def _heredoc_owner_feeds_shell(owner: str, commands_feed_shell,
                               may_be_shell=None, reads_stdin=None) -> bool:
    """Whether a heredoc opened on ``owner`` reaches a shell that runs it as a
    script (XERK-1618). ``commands_feed_shell()`` says whether any command on
    the heredoc-free line reads its stdin as one; the caller memoises it.
    ``may_be_shell(word)`` and ``reads_stdin(stage)`` read a program word that
    is not literal (XERK-1624); by default only literal shell names count.

    The line's first word alone missed three owners bash runs the body for:
    `bash<<EOF` (one word), `(bash <<EOF` (a subshell) and `{ bash; } <<EOF`
    (a group's redirect feeds every reader in it). Asked of every way bash
    may form names on the line: `bas``h <<EOF`, `cat <<EOF | {bas,-s}h`
    (XERK-1629).
    """
    if may_be_shell is None:
        may_be_shell = lambda word: _basename(word) in _SCRIPT_READERS  # noqa: E731
    if reads_stdin is None:
        reads_stdin = _reads_stdin_grouped
    return any(_heredoc_owner_reading_feeds_shell(text, commands_feed_shell,
                                                  may_be_shell, reads_stdin)
               for text in _name_readings(owner))


def _heredoc_owner_reading_feeds_shell(owner: str, commands_feed_shell,
                                       may_be_shell, reads_stdin) -> bool:
    # The splitter reads the `&` of `2>&1` / `&>f` as a background operator
    # and the `|` of `>|f` as a pipe, which cut `bash 2>&1 <<EOF` away from
    # its program. Only the program is asked of these segments, so both go.
    unredirected = re.sub(r"[<>]&|&>|>\|", lambda m: m[0].strip("&|"), owner)
    segments = _split_segments(unredirected)
    # ...and an operator inside a substitution cut its word apart too
    # (`ba$(rev<<<hs;)`, `en$(… | rev)`), so the owner is also split with each
    # one a placeholder, read as an unknown name (XERK-1624, XERK-1644).
    blanked = _owner_substs(unredirected)
    if blanked != unredirected:
        segments = list(dict.fromkeys(segments + _split_segments(blanked)))
    if any("<<" in seg and any(map(may_be_shell, _heredoc_segment_programs(seg)))
           for seg in segments):
        return True
    # A compound command's redirect feeds every command in it, and the group
    # may open lines earlier (`{` / `bash` / `} <<EOF`). Finding where it
    # starts, which redirects stand between its closer and `<<`, or which of
    # its parens are quoted (`(X='a)' bash) 2>')' <<EOF`) lost to bash's
    # grammar each time. So any closer on the line and any shell named on the
    # whole command counts. That only ever denies more.
    if _GROUP_CLOSER_RE.search(owner) and commands_feed_shell():
        return True
    # `cat <<EOF | bash`, and `| (bash)` / `| { bash; }` alike.
    return any(reads_stdin(st) for st in segments[1:])


def _expand_raw_too(command: str) -> list[tuple[list[str], str]]:
    _SPLICES_ESCAPED[0] = 0
    out = _expand_segments(command)
    if _SPLICES_ESCAPED[0]:
        _SPLICE_RAW[0] = True
        try:
            out = out + _expand_segments(command)
        finally:
            _SPLICE_RAW[0] = False
    return out


def _script_readings(script: str) -> list[str]:
    """``script`` as a word shlex produced, and again with each `\\$` before a
    parameter unescaped.
    Inside `"…"` bash drops that backslash and shlex keeps it, so
    `bash -c "echo \\${a:-'}' #}; rm -rf /"` reached the re-parse with an
    escaped `$` and its `#` read as a comment (XERK-1585); `\\$'…'` likewise
    (XERK-1611); and `eval "\\$x rm …"` with a literal `$x` as its program,
    never an unset one (XERK-1615).
    The token no longer says which quoting it came from; reading both fails
    closed. Only a parameter: an escaped `$(` or backtick is already
    classified where it sits, and unescaping those too nested real scripts
    past _MAX_EXPAND_DEPTH."""
    plain = _ESCAPED_PARAM_RE.sub("$", script).replace("\\$'", "$'")
    if plain == script:
        return [script]
    # A second whole expansion at every eval / `-c` level: charged, so a long
    # nest of them is too large rather than past the hook timeout.
    _spend(len(plain))
    return [script, plain]


def _heredoc_readings(body: str) -> list[str]:
    """An UNQUOTED heredoc body as written, and as the shell it feeds reads
    it: bash drops a `\\` before `\\`, `$`, a backtick or a newline there, so
    `bash <<EOF` / `\\$x rm …` runs an unset `$x`, `\\<newline>` joins two
    lines, and `\\\\\\$x` is one escape level down (XERK-1615). Charged to the
    growth budget like the other added readings."""
    plain = re.sub(r"\\([\\$`\n])", lambda m: "" if m.group(1) == "\n" else m.group(1), body)
    if plain == body:
        return [body]
    _spend(len(plain))
    return [body, plain]


# A `\$` before a parameter, which a double-quoted `-c`/eval script unescapes.
_ESCAPED_PARAM_RE = re.compile(r"(?<!\\)\\\$(?=[{A-Za-z_@*0-9!])")


# `$1`, `${12}`, `$@`, `${*}` — a shell's positional parameters — and their
# operator forms (`${1:-x}`, `${@:2}`, `${1%/}`, `${1:-"$x"}`), read as the whole value.
# `${!#}` is the last one.
_POSITIONAL_RE = re.compile(
    r"\$(?:\{([0-9]+|[@*])(?:[^{}'\"`$]|\$\{[^{}]*\}|\$\w|\"[^\"]*\"|'[^']*')*\}|([0-9@*])"
    r"|\{(!#)\})")
# `for p; do` / `for p do` loops over "$@".
# `select v; do` with no `in` lists `"$@"` as `for v; do` does (XERK-1658).
_IMPLICIT_FOR_RE = re.compile(r"\b(for|select)([ \t]+[A-Za-z_]\w*)(?=[ \t]*(?:;|\n|(do\b)))")
# A `shift` moves every positional down; this many shifts are read.
_MAX_SHIFTS = 8
_SHIFT_RE = re.compile(r"(?<![\w.-])shift(?![\w.-])(?:[ \t]+([0-9]+))?")
_LOOP_RE = re.compile(r"\b(?:while|until|for|select)\b")


def _slice_positionals(args: list, spec: str) -> list | None:
    """``${@:off}`` / ``${@:off:len}`` over the positional ARRAY ``args`` (its
    `$0` first), None if the offset/length is not plain arithmetic. Negative
    counts from the end, as bash does."""
    nums = [_arith_offset(b) for b in spec.split(":")[:2]]
    if None in nums or not nums:
        return None
    off = nums[0]
    start = off if off >= 0 else max(len(args) + off, 0)
    if len(nums) == 1:
        sub = args[start:]
    else:
        end = start + nums[1] if nums[1] >= 0 else len(args) + nums[1]
        sub = args[start:end] if end >= start else []
    return [w for w in sub if w is not None]


class _BoundTooLong(Exception):
    """A bound reading past the ``limit`` `_bind_positionals` was given."""


def _bind_positionals(script: str, args: list, raw: bool = False,
                      every: bool = False, limit: int | None = None) -> str:
    """``script`` with the positional parameters ``sh -c '<script>' <args>``
    gives it spliced in: ``args[0]`` is `$0`, the rest `$1`… and `$@`/`$*`.

    `find /etc -exec sh -c 'rm -rf "$1"' _ {} +` hands the path to the script
    as `$1`, so classifying the script alone saw only `rm -rf "$1"` (XERK-1600).
    A parameter with no argument (or a None `$0`) is left as written, never
    guessed at.

    ``raw`` args are shell TEXT from the line that passed them (a function
    call's or `set --`'s words, XERK-1626), spliced as written so a `"$2"` the
    caller holds stays live for its own binding. ``every`` reads each
    parameter as ALL the args: the one reading for calls past the cap.

    With a ``limit``, the splices are not charged to the growth budget (the
    caller's own byte budget bounds them) and a reading growing past it
    raises `_BoundTooLong`."""
    if not args or "$" not in script:
        return script
    script = _IMPLICIT_FOR_RE.sub(
        lambda m: f'{m.group(1)}{m.group(2)} in "$@"' + (";" if m.group(3) else ""), script)
    states = _quote_states(script)
    grown = [len(script)]

    def rep(m: "re.Match[str]") -> str:
        if not _live_dollar(script, m.start()):
            return m.group(0)
        name = m.group(1) or m.group(2) or m.group(3)
        state = states[m.start()] if m.start() < len(states) else ""
        # The operator applied, as bash does (XERK-1636): `${@/tmp/etc}`,
        # and `${1:-/etc}` with `$1` unset or empty is `/etc`.
        op = _VAR_OP_RE.match(m.group(0)[2 + len(name):-1]) if m.group(1) else None
        # `${@:N}` / `${@:N:M}` slices the positionals as an ARRAY (XERK-1655),
        # not the joined string `_apply_var_op`'s `:` would.
        slice_op = op and name in ("@", "*") and op.group(1) == ":"
        if name == "!#":
            words = [args[-1]] if args[-1] is not None else []
        elif slice_op:
            sliced = _slice_positionals(args, op.group(2))
            if sliced is None:
                return m.group(0)
            words, op = sliced, None
        elif name in ("@", "*") or every and name != "0":
            if len(args) < 2:
                return m.group(0) if not op or op.group(1) not in _VAR_DEFAULT_OPS \
                    else op.group(2)
            words = args[1:]
        elif int(name) < len(args) and args[int(name)] is not None:
            words = [args[int(name)]]
        elif op and op.group(1) in _VAR_DEFAULT_OPS:
            return op.group(2)
        else:
            return m.group(0)
        # A non-default operator (`${1#x}`, `${1%/}`, `${@/a/b}`) is APPLIED,
        # raw or not — a raw word is dequoted first and then spliced as a
        # literal, since it is now a concrete value. One that still carries a
        # `$` (a caller positional or a substitution) is left live, as raw does.
        raw_applied = False
        if op and op.group(1) not in _VAR_DEFAULT_OPS:
            if raw:
                new_words = []
                for w in words:
                    if "$" in w or "`" in w:
                        new_words.append(w)
                    else:
                        new_words.append(_var_op_text(_dequote_value(w), op.group(1),
                                                      op.group(2)))
                        raw_applied = True
                words = new_words
            else:
                words = [_var_op_text(w, op.group(1), op.group(2)) for w in words]
        elif op and not raw and op.group(1) in _VAR_DEFAULT_OPS:
            words = [w if w or op.group(1)[:1] != ":" else op.group(2) for w in words]
        if raw and not raw_applied:
            if state == "'":
                return m.group(0)  # the function's shell never expands it
            if not state and not _in_assignment_word(script, m.start()):
                # An unquoted use word-splits its value: `f(){ $1; }; f 'rm
                # -rf /etc'` runs `rm` (XERK-1657). A quoted word is its text
                # unquoted: plain text spliced as a `$x` value is, and one
                # holding an expansion dequoted only, so `"$v"` stays live
                # (and splits) for the line's own substitution.
                words = [w if not re.search(r"['\"]", w)
                         else _dequote_value(w) if re.search(r"[$`]", w)
                         else _quote_literal(_dequote_value(w), "") for w in words]
            out = " ".join(words)
            if state == '"':
                out = '"' + out + '"'
        elif not state and _in_assignment_word(script, m.start()):
            # An assignment keeps the value whole: escaped bare, `sh -c 'x=$1;
            # $x' _ 'rm …'` read `x=rm` (XERK-1657 QA).
            out = '"' + '" "'.join(_quote_literal(w, '"') for w in words) + '"'
        elif state == '"' and (name == "@" or every):
            # ...and so is every argument a parameter may be (`every`).
            # `"$@"` is one word per argument, not one word of them all.
            out = '" "'.join(_quote_literal(w, state) for w in words)
        else:
            out = " ".join(_quote_literal(w, state) for w in words)
        if limit is None:
            _spend(len(out))
        else:
            grown[0] += len(out)
            if grown[0] > limit:
                raise _BoundTooLong
        return out

    return _POSITIONAL_RE.sub(rep, script)


_ASSIGN_HEAD_RE = re.compile(r"[A-Za-z_]\w*(?:\[[^]]*\])?\+?=")


# A `$` and the name it expands split by quotes (`'$'v`, `"$"'v'`, `\$\v`):
# only an `eval`'s join makes it a use (XERK-1657).
_QUOTE_SPLIT_USE_RE = re.compile(
    r"\$(?:['\"\\]+\{?|\{['\"\\]|\{!?[A-Za-z_]\w*['\"\\])")


def _in_assignment_word(text: str, pos: int) -> bool:
    """Whether ``pos`` sits in an ASSIGNMENT (`x=$1`, `local x=a$1`), where
    bash never splits an expansion: escaped there, `f(){ x=$1; $x; }; f 'rm
    …'` read `x=rm` (XERK-1657 QA). Only a command's leading assignments and
    a declaring builtin's words count: `env x=$1` passes an ARGUMENT, split,
    and in `x=case $1` the `$1` is the program (XERK-1657 QA)."""
    start = pos
    while start and text[start - 1] not in " \t\n;&|()`":
        start -= 1
    if not _ASSIGN_HEAD_RE.match(text, start):
        return False
    head = re.split(r"[;&|(){}`\n]", text[:start])
    # A quoted or escaped separator is no command start (`env a\;x=$1`,
    # `env "a;"x=$1`, QA): any quote or `\` near it reads as an argument.
    if len(head) > 1 and re.search(r"[\\'\"]", head[-2][-1:] + head[-1]):
        return False
    before = head[-1].split()
    k = 0
    while k < len(before) and (before[k] in _CMD_START_WORDS or _ASSIGN_HEAD_RE.match(before[k])):
        k += 1
    if k < len(before) and before[k] in _DECLARERS:
        k += 1
        while k < len(before) and (before[k].startswith("-") or _ASSIGN_HEAD_RE.match(before[k])):
            k += 1
    return k == len(before)


_DECLARERS = frozenset(("local", "export", "declare", "readonly", "typeset"))
_CMD_START_WORDS = frozenset(("then", "do", "else", "elif", "if", "while", "until", "!", "time"))


def _shifted(args: list, text: str, every: bool = False) -> list[list]:
    """``args`` (`$0` first), and as each `shift` in ``text`` leaves them: one
    list per literal `shift [N]`, in order. Every count when a loop or a
    recursive call (``every``) may repeat one, or a count is computed
    (`shift $n`, `shift $((2))`, `s=shift; $s`)."""
    if len(args) < 3:
        return [args]
    shifts = []
    for m in _SHIFT_RE.finditer(text):
        rest = text[m.end():].lstrip(" \t")
        if (m.start() and text[m.start() - 1] not in " \t;&|\n({`"
                or not m.group(1) and rest[:1] not in ("", ";", "&", "|", "\n", ")", "}", "#")):
            every = True
        shifts.append(int(m.group(1) or 1))
    if not shifts:
        return [args]
    if every or _LOOP_RE.search(text):
        counts = range(min(len(args) - 1, _MAX_SHIFTS + 1))
    else:
        counts = [0, *itertools.accumulate(shifts)][:_MAX_SHIFTS + 1]
    return [[args[0], *args[1 + k:]] for k in dict.fromkeys(counts) if k < len(args) - 1]


# A function definition up to its body's opener: `f() {`, `function f {`,
# `function f() (`, comment lines between allowed (`f() # c` NL `{`). Bodies of other
# shapes (`f() if …`) are not read here.
_FUNC_BODY_RE = re.compile(
    r"(?:^|(?<=[\s;&|()]))(?:function[ \t]+([^\s();|&<>'\"`$]+)(?:[ \t]*\([ \t]*\))?"
    r"|([^\s;&|()<>'\"`$]+)[ \t]*\([ \t]*\))(?:\s|#[^\n]*\n)*([{(])")
# What may stand before a command word: keywords, a group opener, assignments.
_CALL_LEAD = (r"(?:^|(?<=[;&|()`{\n]))[ \t]*"
              r"(?:(?:then|do|else|elif|if|while|until|time|eval|coproc|builtin|command"
              r"|!|\{|\()[ \t]+"
              r"|[A-Za-z_]\w*=[^\s;&|]*[ \t]+)*")
_SET_RE = re.compile(_CALL_LEAD + r"(set)(?=[ \t])")
# A word the union reading leaves out: no path, glob, option, quote or expansion.
_PLAIN_WORD_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.,:+=@%-]*")
# Per-call (and per-`set`) readings stop once they total this many times the
# line's length (plus a floor); the calls past that share one reading.
_POSITIONAL_READ_FACTOR = 2
_POSITIONAL_READ_FLOOR = 4096


def _word_breaks(text: str, states: list[str], i: int, stops: str):
    """Indices from ``i`` of characters in ``stops`` outside quotes and outside
    any `(…)`/`$(…)`/backticks — where a word or a command ends. A backtick
    in ``stops`` is one that closes a body the text started inside."""
    depth, tick = 0, False
    for j in range(i, len(text)):
        ch = text[j]
        if states[j]:
            continue
        if ch == "`" and not tick and not depth and "`" in stops:
            yield j
        elif ch == "`":
            tick = not tick
        elif tick:
            continue
        elif ch == "(":
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
        elif not depth and ch in stops and not (
                ch == "&" and (text[j - 1:j] in (">", "<") or text[j + 1:j + 2] == ">")):
            # (`2>&1`, `&>f` and `<&3` are redirections, not a `&`.)
            yield j


def _args_end(text: str, states: list[str], i: int, in_tick: bool = False) -> int:
    """Where the command whose words start at ``i`` ends."""
    return next(_word_breaks(text, states, i, ";&|\n)" + "`" * in_tick), len(text))


# A redirection word: its target is glued (`2>/dev/null`) or the next word.
_REDIRECT_WORD_RE = re.compile(r"(?:[0-9]+|&)?(?:>>?|<<?<?|>&|<&|>\||<>)(?!\()(.*)", re.DOTALL)


def _call_words(text: str) -> list[str]:
    """A call's argument words, its redirections left out: `f 2>/dev/null
    /etc` hands `/etc` to the function as `$1`."""
    words, skip = [], False
    for w in _raw_words(text):
        if skip:
            skip = False
            continue
        m = _REDIRECT_WORD_RE.fullmatch(w)
        if m:
            skip = not m.group(1)
            continue
        words.append(w)
    return words


def _raw_words(text: str) -> list[str]:
    """``text`` split into words as written, quotes kept: `""/etc""` is one."""
    words, start = [], 0
    for j in (*_word_breaks(text, _quote_states(text), 0, " \t"), len(text)):
        if j > start:
            words.append(text[start:j])
        start = j + 1
    return words


def _set_positionals(words: list[str]) -> list[str] | None:
    """The words `set <words>` assigns, or None if it assigns none."""
    i = 0
    while i < len(words) and words[i][:1] in ("-", "+"):
        if words[i] in ("--", "-"):
            i += 1
            break
        i += 2 if words[i] in ("-o", "+o") else 1
    return words[i:] or None


_EMPTY_WORD_RE = re.compile(r"(?:''|\"\")+")


def _set_lists(words: list[str], prev: list[tuple[list[str], bool]],
               again: bool) -> list[tuple[list[str], bool]]:
    """The lists a `set` of ``words`` may assign after ``prev``'s, each with
    whether its positions are unknown (read with EVERY parameter bound to
    every word).

    A word naming a positional (`set -- "$@" x`, `set -- "$1" x`) is bound to
    the previous `set`'s words, and any left unbound becomes a one-word slot,
    also read dropped (`"$@"` of none is no word). Kept raw, each level bound
    it to itself and the reading grew; dropped outright, it renumbered every
    word after it. Where a loop may repeat it (``again``), or the previous
    list's positions are already unknown, no pass count is right
    (`for …; do set -- x "$@"; done`): its words, at every position."""
    if not any(_POSITIONAL_RE.search(w) for w in words):
        return [(words, False)]
    out: list[list[str]] = []
    for cur, _ in prev[:2]:
        text = " ".join(_bind_positionals(w, [None, *cur], raw=True) for w in words)
        cur = _raw_words(_POSITIONAL_RE.sub("", text))
        out += [cur, [w for w in cur if not _EMPTY_WORD_RE.fullmatch(w)]]
    if again or any(every for _, every in prev):
        merged = [w for ws in out for w in ws if not _EMPTY_WORD_RE.fullmatch(w)]
        return [(list(dict.fromkeys(merged)), True)] if merged else []
    return [(list(ws), False) for ws in dict.fromkeys(map(tuple, out)) if ws][:2]


# A body read to each `}` that may or may not close it, up to this many.
_MAX_BODY_ENDS = 4


def _closes_body(text: str, i: int, states: list[str]) -> bool | str:
    """Whether the `}` at ``i`` stands where a command has ended: after `;`,
    `&`, a newline, or `fi`/`done`/`esac` as a command — `fi }` closes a body
    as surely as `; }` does (a QA bypass when only `;&\\n` counted). After
    `)` or `}`, "maybe": a group's closer or a word's (`$(x) }`)."""
    j = i - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    if j < 0:
        return False
    if _separates(text, j, states):
        return True
    if text[j] in ")}":
        return "maybe"
    for kw in ("fi", "done", "esac"):
        # ...a keyword only where IT stands as a command: `echo done }`'s `}`
        # is a word.
        k = j + 1 - len(kw)
        if k >= 0 and text.startswith(kw, k):
            k -= 1
            while k >= 0 and text[k] in " \t":
                k -= 1
            if k < 0 or _separates(text, k, states):
                return True
    return False


def _separates(text: str, j: int, states: list[str]) -> bool:
    """Whether ``text[j]`` ends a command: an unescaped `;`, `&` or newline,
    never `\\;`, a `\\`-newline continuation or the `&` of `>&`/`<&` (QA:
    `echo \\; fi }` closed a body bash keeps open)."""
    if text[j] not in ";&\n":
        return False
    if text[j] == "\n" and j and states[j - 1] == "#":
        return True  # a comment's end, whatever it ends in (`# c\\`)
    k = j - 1
    while k >= 0 and text[k] == "\\":
        k -= 1
    if (j - 1 - k) % 2:
        return False
    return not (text[j] == "&" and j and text[j - 1] in "<>")


# A function body that is a compound command other than `{…}`/`(…)`: bash
# allows `f() for p; do …; done`, `f() if …; fi`, `f() [[ … ]]`, `f() ((…))`.
# `_FUNC_HEADER_RE` matches the header (and comment/ws before the body); the
# body starts at its end and runs to the compound's own closer.
_FUNC_HEADER_RE = re.compile(
    r"(?:^|(?<=[\s;&|()]))(?:function[ \t]+([^\s();|&<>'\"`$]+)(?:[ \t]*\([ \t]*\))?"
    r"|([^\s;&|()<>'\"`$]+)[ \t]*\([ \t]*\))(?:[ \t]|\n|#[^\n]*\n)*")


def _compound_body_end(text: str, states: list[str], start: int) -> int | None:
    """If ``text[start]`` opens a compound command (`for`/`if`/`while`/`until`/
    `select`/`case`, `[[ … ]]` or `((…))`), the index just past its closer,
    else None. Nested compounds are tracked so an inner `done`/`fi` does not
    close the body early; quoted text is skipped (``states``)."""
    n = len(text)
    stack: list[str] = []
    i = start
    while i < n:
        if states[i]:
            i += 1
            continue
        # The body's own opener sits right after the header `)`, which
        # `_at_command_start` does not read as a command boundary; a nested one
        # must pass it.
        at_start = i == start or _at_command_start(text, i)
        if (text.startswith("[[", i) or text.startswith("((", i)) and at_start:
            stack.append("]]" if text[i + 1] == "[" else "))")
            i += 2
            continue
        if i == start:
            kw = next((k for k in _COMPOUND_OPENERS if _word_at(text, i, k)), "")
        else:
            kw = _compound_opener(text, i)
        if kw:
            stack.append(_COMPOUND_OPENERS[kw])
            i += len(kw)
            continue
        if not stack:
            return None  # text[start] did not open a compound command
        top = stack[-1]
        if top in ("]]", "))"):
            if text.startswith(top, i):
                stack.pop()
                i += 2
                if not stack:
                    return i
                continue
        elif _compound_closes(text, i, top):
            stack.pop()
            i += len(top)
            if not stack:
                return i
            continue
        i += 1
    return None  # unclosed: fail open rather than read past the function


# `eval` / `trap` at a command start: their ACTION string is code the shell runs
# later, so a call or `set` inside it never reached `_positional_readings` beside
# the line's function defs and `set`s (XERK-1655).
_EVAL_TRAP_RE = re.compile(_CALL_LEAD + r"(eval|trap)(?=[ \t])")
_MAX_EVAL_INLINE = 2
_MAX_CALL_INLINE = 4
# `$(declare -f NAME)` / `` `typeset -f NAME` `` prints NAME's definition.
_DECLARE_F_RE = re.compile(r"[$`]\(?\s*(?:declare|typeset)\s+-f[A-Za-z]*\s+"
                           r"([^\s();|&'\"`$]+)\s*[)`]")
# Programs a captured function output is only WORTH inlining in front of —
# where it names a path that is deleted/rechmod'd. Elsewhere `$(f)` output is
# data, so inlining it only re-expands the line (XERK-1655 QA deadline).
_OUTPUT_TARGET_PROGS = frozenset({"rm", "unlink", "rmdir", "chmod", "chown", "chgrp",
                                  "shred", "truncate", "dd", "mkfs", "mv", "cp"})


def _capture_feeds_destructive(text: str, states: list[str], at: int) -> bool:
    """Whether the substitution starting at ``at`` is an operand of a
    destructive program (its enclosing simple command's first word)."""
    j = at - 1
    while j >= 0 and not (states[j] == "" and (text[j] in ";&|\n(`"
                                               or (text[j] == "{" and text[j + 1:j + 2] in " \t"))):
        j -= 1
    words = _raw_words(text[j + 1:at])
    k = 0
    while k < len(words) and ("=" in words[k] and _ENV_ASSIGN.match(words[k])
                              or words[k][:1] in "<>" or words[k] in ("!", "time")):
        k += 1
    return k < len(words) and _basename(words[k].strip("'\"\\")) in _OUTPUT_TARGET_PROGS


def _eval_inlined_lines(text: str) -> list[str]:
    """``text`` with every `eval <args>` / `trap <action> <sigs>` replaced by
    the action it will run, variables resolved (`c='rm …"$1"'; eval "$c"` →
    `c=…; rm …"$1"`). An ADDED reading: `_positional_readings` then binds the
    revealed call/`set` against the line's defs, and `_expand` classifies any
    command the action reveals directly."""
    if "eval" not in text and "trap" not in text:
        return []
    states = _quote_states(text)
    vals = _var_values(text)
    pieces: list[tuple[int, int, str]] = []
    for m in _EVAL_TRAP_RE.finditer(text):
        if states[m.start(1)]:
            continue
        kind = m.group(1)
        end = _args_end(text, states, m.end(1))
        # `_call_words` drops `eval`'s own redirections (`eval "$@" 2>&1`), so a
        # pure args-passthrough action reads as just `$@` and is skipped below.
        words = _call_words(text[m.end(1):end])
        while words and words[0] == "--":
            words = words[1:]
        if kind == "trap":
            # `trap -p`/`trap` with no action adds nothing; the action is the
            # first word, the rest signal names.
            while words and words[0][:1] == "-" and words[0] != "-":
                words = words[1:]
            if not words:
                continue
            action = _dequote_value(words[0])
        else:
            if not words:
                continue
            action = " ".join(_dequote_value(w) for w in words)
        action = _substitute_vars(action, vals)
        # A substitution in the action re-expands on every reading once spliced
        # into the line; skip it (the direct call/set shapes carry none) so a
        # substitution-heavy eval does not blow the decide deadline (XERK-1655 QA).
        if "$(" in action or "`" in action:
            continue
        # An action that is ONLY positional parameters (`eval "$@"`, the
        # args-passthrough idiom) reveals no hidden call/set — it just re-runs
        # the args, which binding already covers — and splicing `$@` binds it
        # per call, 6-11x on real QA rigs that call such a function many times
        # (XERK-1655 QA deadline). The ticket's eval shapes all carry a literal.
        if not _POSITIONAL_RE.sub("", action).strip():
            continue
        if action.strip() and action != text[m.start(1):end]:
            pieces.append((m.start(1), end, action))
    if not pieces:
        return []
    buf, last = [], 0
    for start, end, action in sorted(pieces):
        if start < last:
            continue
        buf.append(text[last:start])
        buf.append(action)
        last = end
    buf.append(text[last:])
    inlined = "".join(buf)
    if inlined == text:
        return []
    _spend(len(inlined))
    return [inlined]


def _positional_readings(text: str, _eval_depth: int = 0) -> list[str]:
    """`_positional_readings_core`, plus readings where `eval`/`trap` action
    strings are inlined so a call or `set` hidden in one binds too (XERK-1655).

    Memoised per decision at the top level: `_expand` re-reads the same line
    once per value pass, and recomputing the inlining (`_find_substs` per pass)
    turned a real function-defining QA rig 10x slower toward the deadline."""
    if _eval_depth == 0 and _budget is not None:
        return _memo("posread", text, _positional_readings_uncached, text, 0)
    return _positional_readings_uncached(text, _eval_depth)


def _positional_readings_uncached(text: str, _eval_depth: int = 0) -> list[str]:
    out = _positional_readings_core(text)
    if _eval_depth < _MAX_EVAL_INLINE and ("eval" in text or "trap" in text):
        for inlined in _eval_inlined_lines(text):
            if inlined == text:
                continue
            out.append(inlined)
            out.extend(_positional_readings_uncached(inlined, _eval_depth + 1))
    return list(dict.fromkeys(out))


def _positional_readings_core(text: str) -> list[str]:
    """Texts ``text`` runs with positional parameters bound (XERK-1626).

    `_bind_positionals` covers `sh -c '<script>' <args>`; a function's `$1`…
    are its call's arguments and a `set -- <words>` sets the line's, so
    `f() { rm -rf "$1"; }; f /etc` and `set -- /etc; rm -rf "$1"` reached the
    classifier as a literal `"$1"`. Returned, each read beside the text:
    - each defined function's BODY bound to each call's words, calls found in
      those bodies too (`f() { g "$@"; }`);
    - the text from each `set` to the next bound to its words, and on a line
      that can replay text (a loop, function, trap…) the whole text too;
    - each bound body bound again to each `set`'s words.
    Only bodies and spans are read, never the whole line per call: that is
    quadratic, and made a XERK-1600 attempt time out the hook. Readings past
    the byte budget give way to ONE per function binding every parameter to
    every remaining call's words — `$1`-as-program past it is a residual.

    Over-reads on purpose: binding ignores where a call or `set` sits."""
    if "$" not in text or ("(" not in text and "function" not in text and "set" not in text):
        return []
    states = _quote_states(text)
    defs: dict[str, list[str]] = {}
    all_defs: dict[str, list[str]] = {}
    for m in _FUNC_BODY_RE.finditer(text):
        if states[m.start()]:
            continue
        opener = m.start(3)
        brace = text[opener] == "{"
        close = "}" if brace else ")"
        name = m.group(1) or m.group(2)
        depth, maybes = 0, 0

        def keep(body: str, name: str = name) -> None:
            all_defs.setdefault(name, []).append(body)
            if _POSITIONAL_RE.search(body) or _IMPLICIT_FOR_RE.search(body):
                defs.setdefault(name, []).append(body)

        for i in range(opener, len(text)):
            if states[i]:
                continue
            if text[i] == text[opener] and (
                    i == opener or not brace or text[i + 1:i + 2] in (" ", "\t", "\n")):
                depth += 1
            elif text[i] == close:
                # `}` closes only after a command ends: `echo }`, `${x}` and
                # a `*})` case pattern are words (QA). After `)` or `}` it may
                # be either (`(cmd) }` vs `echo $(x) }`): both are read.
                ends = _closes_body(text, i, states) if brace else True
                if ends == "maybe" and depth == 1:
                    if maybes < _MAX_BODY_ENDS:
                        maybes += 1
                        keep(text[opener + 1:i])
                    continue
                if ends:
                    depth -= 1
                    if not depth:
                        keep(text[opener + 1:i])
                        break
    # Non-brace compound bodies (`f() for …; done`, `f() if …; fi`): the header
    # is matched here and the body runs from its end to the compound's closer.
    for m in _FUNC_HEADER_RE.finditer(text):
        if states[m.start()]:
            continue
        start = m.end()
        if start >= len(text) or text[start] in "{(":
            continue  # a `{…}`/`(…)` body is read above
        end = _compound_body_end(text, states, start)
        if end is not None:
            body = text[start:end]
            name = m.group(1) or m.group(2)
            all_defs.setdefault(name, []).append(body)
            if _POSITIONAL_RE.search(body) or _IMPLICIT_FOR_RE.search(body):
                defs.setdefault(name, []).append(body)
    out: list[str] = []
    seen = {text}
    room = [_POSITIONAL_READ_FACTOR * len(text) + _POSITIONAL_READ_FLOOR]

    def add(reading: str, budgeted: bool = True) -> bool:
        """Keep ``reading``; False if it is a repeat, or over the budget."""
        if reading in seen or (budgeted and len(reading) > room[0]):
            return False
        if budgeted:
            room[0] -= len(reading)
        seen.add(reading)
        out.append(reading)
        return True

    if all_defs:
        # `rm -rf "$(f /etc)"` runs what `f` PRINTS, so a call is also inlined
        # IN PLACE — `f`'s body, its arguments bound — and the result read: the
        # command-substitution machinery then resolves `$(echo "/etc")` to
        # `/etc` (XERK-1655). Nested calls (`$(f2 "$1")` in f's body) resolve
        # over a few passes. All functions, not just positional ones: a body
        # printing a literal (`f() { echo /etc; }`) matters for its output too.
        # A self-recursive function is never inlined in place: its body holds a
        # call to itself, which would nest every pass (a plain countdown became
        # "too deep", XERK-1626 QA). The positional `work` loop handles those.
        # Nor is a body that itself holds a `$(…)`/backtick: splicing it into a
        # `$(…)` re-expands that nest on every reading, 10-23x on real QA rigs
        # that `$(f)`-capture a substitution-heavy body (XERK-1655 QA, deadline).
        inlinable = {n: b for n, b in all_defs.items()
                     if not any(re.search(r"(?<![\w.-])" + re.escape(n) + r"(?![\w.-])", body)
                                or "$(" in body or "`" in body
                                for body in b)}
        inlined = text
        if inlinable:
            inline_re = re.compile(_CALL_LEAD + r"((['\"]?)\\?("
                                   + "|".join(map(re.escape, inlinable))
                                   + r")\2)(?=[ \t;&|)<>\n`]|$)")
            inlined_names: set[str] = set()
            for _ in range(_MAX_CALL_INLINE):
                st = _quote_states(inlined)
                # Only a call whose OUTPUT is captured — inside a `$(…)` or
                # backtick — needs inlining; a top-level call is already bound
                # by the `work` loop below, and inlining it only spends budget
                # (big QA scripts went "too large", XERK-1655 corpus replay).
                spans = [(s.start(), s.end()) for s in _find_substs(inlined)
                         if inlined[s.start()] in "$`"]
                if not spans:
                    break
                repls = []
                this_pass: set[str] = set()
                for m in inline_re.finditer(inlined):
                    if st[m.start(1)] not in ("", m.group(2) or "\\") or m.group(3) in inlined_names:
                        continue
                    span = next(((s, e) for s, e in spans if s < m.start(1) < e), None)
                    if span is None:
                        continue
                    # Only inline a capture that FEEDS a destructive command
                    # (`rm -rf "$(f)"`); elsewhere (`id=$(mkid)`, a benign
                    # pipeline) the output is data and inlining just re-expands
                    # the line — 10-23x on real QA rigs (XERK-1655 QA deadline).
                    if not _capture_feeds_destructive(inlined, st, span[0]):
                        continue
                    end = _args_end(inlined, st, m.end(1))
                    cwords = _call_words(inlined[m.end(1):end])
                    body = inlinable[m.group(3)][0]
                    if len(body) > room[0]:
                        continue
                    try:
                        bound = _bind_positionals(body, [None, *cwords], raw=True, limit=room[0])
                    except _BoundTooLong:
                        continue
                    repls.append((m.start(1), end, bound))
                    this_pass.add(m.group(3))
                if not repls:
                    break
                inlined_names |= this_pass
                buf, last = [], 0
                for s, e, r in sorted(repls):
                    if s < last:
                        continue
                    buf.append(inlined[last:s])
                    buf.append(r)
                    last = e
                buf.append(inlined[last:])
                nxt = "".join(buf)
                if nxt == inlined:
                    break
                inlined = nxt
        if inlined != text:
            add(inlined)
        # `bash -c "$(declare -f f); f /etc"` exports f into the child shell:
        # `declare -f f` prints f's definition, which the child then runs
        # (XERK-1655). Splice that definition in so the `-c` script is read with
        # f defined, and its call binds.
        def _declare_f(mm: "re.Match[str]") -> str:
            body = all_defs.get(mm.group(1))
            if not body or "$(" in body[0] or "`" in body[0]:
                return mm.group(0)  # a substitution-heavy body re-expands too far
            return f"{mm.group(1)}() {{{body[0]}}}; "

        declared = _DECLARE_F_RE.sub(_declare_f, text)
        if declared != text:
            add(declared)
    if defs:
        # `'f'`, `"f"` and `\f` call the function too.
        call_re = re.compile(_CALL_LEAD + r"((['\"]?)\\?(" + "|".join(map(re.escape, defs))
                             + r")\2)(?=[ \t;&|)<>\n`]|$)")
        union: dict[str, list[str]] = {}
        # Each reading with the functions it was bound inside: a call back
        # into one of them (recursion) is followed once, never again — every
        # pass nested `$(( $1 - 1 ))` deeper until "too deep".
        work: list[tuple[str, tuple[str, ...]]] = [(text, ())]
        while work:
            t, path = work.pop()
            t_states = states if t is text else _quote_states(t)
            ticks = [j for j in range(len(t)) if t[j] == "`" and not t_states[j]] if "`" in t else []
            for m in call_re.finditer(t):
                name = m.group(3)
                # The name's own quote or escape is its only quoting allowed.
                if t_states[m.start(1)] not in ("", m.group(2) or "\\") or path.count(name) > 1:
                    continue
                # Inside a backtick body, its closer ends the words too.
                in_tick = bisect.bisect_left(ticks, m.start(1)) % 2 == 1
                arg_text = t[m.end(1):_args_end(t, t_states, m.end(1), in_tick)]
                words = _call_words(arg_text)
                if not words or arg_text.lstrip()[:1] == "(":
                    continue
                # A word naming the caller's own positionals (`f "$@" /etc`,
                # unknown here) may be no word at all: also read without it.
                lists = [words, [w for w in words if not _POSITIONAL_RE.search(w)]]
                if lists[1] == words or not lists[1]:
                    lists.pop()
                # `f ${HOME:+/etc}` passes the alternative as the argument when
                # the name is set (XERK-1655); read it taken.
                taken = [_alternatives_taken(w) for w in words]
                if taken != words:
                    lists.append(taken)
                # `f {a,b} /etc` brace-expands to three arguments, so `$3`
                # is `/etc` (XERK-1655).
                braced = [bw for w in words for bw in _raw_words(_expand_braces(w))]
                if braced != words:
                    lists.append(braced)
                for body in defs[name]:
                    if len(body) > room[0]:
                        # Spent: not even bound, or binding alone is quadratic.
                        union.setdefault(name, []).extend(words)
                        continue
                    self_calls = bool(re.search(
                        r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])", body))
                    # A body calling itself may shift any number of times.
                    for args in (shifted for ws in lists for shifted in _shifted(
                            [None, *ws], body, self_calls)):
                        try:
                            reading = _bind_positionals(body, args, raw=True, limit=room[0])
                        except _BoundTooLong:
                            union.setdefault(name, []).extend(words)
                            continue
                        if reading == body or reading in seen:
                            continue
                        if add(reading):
                            work.append((reading, path + (name,)))
                        else:
                            union.setdefault(name, []).extend(words)
                    # A `shift` under a loop may run past `_MAX_SHIFTS` (`while
                    # [ $# -gt 0 ]; do rm -rf "$1"; shift; done`), so the last
                    # argument never lands at `$1` in the capped shift lists
                    # (XERK-1655). Bind every parameter to every argument too.
                    if _SHIFT_RE.search(body) and (_LOOP_RE.search(body) or self_calls):
                        for ws in lists:
                            try:
                                reading = _bind_positionals(body, [None, *ws], raw=True,
                                                            every=True, limit=room[0])
                            except _BoundTooLong:
                                continue
                            if reading != body:
                                add(reading)
        for name, words in union.items():
            # Only words that can name a path or option: every word at every
            # parameter is (refs × calls), and plain names (`a0`…`a400`) made
            # a benign 5 KB line "too large" (QA).
            words = [w for w in dict.fromkeys(words) if not _PLAIN_WORD_RE.fullmatch(w)]
            if not words:
                continue
            for body in defs[name]:
                add(_bind_positionals(body, [None, *words], raw=True, every=True), False)
    replays = bool(_REPLAYS_RE.search(text))
    sets, prev = [], [([], False)]
    for m in _SET_RE.finditer(text):
        if states[m.start(1)]:
            continue
        end = _args_end(text, states, m.end(1))
        arg_text = text[m.end(1):end]
        # `set -- $(printf '%s ' a /etc)` sets the positionals to the words the
        # substitution PRINTS, so `$2` is `/etc` (XERK-1655); resolve it first.
        if "$(" in arg_text or "`" in arg_text:
            arg_text = _sub_substs(arg_text, _subst_text)
        words = _set_positionals(_raw_words(arg_text))
        if words:
            prev = _set_lists(words, prev, replays) or [([], False)]
            sets.append((m.start(), m.end(1), end, prev))
    if sets:
        bodies = list(out)
        # A loop may run text BEFORE a `set` after it (`for …; do rm -rf "$1";
        # set -- /etc; done`), so on a line that can replay text, the text up
        # to each `set` is bound too — every `set` in it emptied (`set --`):
        # left in, each level re-bound the line to its own words and grew it
        # until "too deep".
        blanked, prev = "", 0
        for k, (start, args_at, end, lists) in enumerate(sets):
            nxt = sets[k + 1][0] if k + 1 < len(sets) else len(text)
            span = text[end:nxt]
            before = blanked + text[prev:start] if replays else ""
            blanked += text[prev:args_at] + " --"
            prev = end
            for words, every in lists:
                for args in _shifted([None, *words], span):
                    bound = _bind_positionals(span, args, raw=True, every=every)
                    if bound != span:
                        add(bound, False)
                for target in (before, *bodies):
                    for args in _shifted([None, *words], target):
                        # Checked before binding, which alone would be quadratic.
                        if target and len(target) <= room[0]:
                            try:
                                bound = _bind_positionals(target, args, raw=True, every=every,
                                                          limit=room[0])
                            except _BoundTooLong:
                                continue
                            if bound != target:
                                add(bound)
    return out


def _stdout_targets(tokens: list[str]) -> tuple[list[str], list[str]]:
    """``tokens`` split into its words and the files its stdout is written to
    (`> f`, `>>f`, `&>f`, `>|f`); other redirections are dropped."""
    words: list[str] = []
    outs: list[str] = []
    i = 0
    while i < len(tokens):
        m = _REDIR_WORD.match(tokens[i])
        if not m:
            words.append(tokens[i])
            i += 1
            continue
        target = tokens[i][m.end():]
        if not target and i + 1 < len(tokens):
            i += 1
            target = tokens[i]
        i += 1
        if m.group(2) in (">", ">>", ">|") and m.group(1) in ("", "1", "&"):
            outs.append(posixpath.normpath(target))
    return words, outs


def _written_scripts(segments: list[str],
                     heredocs: list[tuple[str, str, bool]], depth: int = 0) -> dict[str, list[str]]:
    """Text the line writes to a file: a printer's output redirected (`echo …
    > f`) and a heredoc `cat`/`tee` writes (`cat > f <<EOF`), by path. A
    later `sh f` / `. f` runs it as a script (XERK-1555)."""
    written: dict[str, list[str]] = {}
    for pipeline in segments:
        # ...and what a `tee f` stage is fed: `echo … | tee f` (XERK-1641 QA).
        fed: str | None = None
        for stage in _split_on_operators(pipeline, groups=True):
            # A write inside a group or compound writes too: `for v in …; do
            # echo "$v" > f; done; sh f` (XERK-1657). Bounded by depth: each
            # level re-splits its body.
            core = _group_core(stage) if depth < _MAX_WRITE_NEST else None
            if core:
                inner = _written_scripts(_split_on_operators(
                    _unwrap_group(core), include_pipe=False, groups=True), [], depth + 1)
                for path, texts in inner.items():
                    written.setdefault(path, []).extend(texts)
            words, outs = _stdout_targets(_strip_prefixes(_tokenize(stage)))
            prog = _basename(words[0]) if words else ""
            text = _printed_from_tokens(words) if words else None
            # ...and one a `-c` script or `eval` makes: `sh -c 'echo … > f';
            # sh f` (XERK-1674).
            script = (_shell_c_script(words[1:]) if prog in _SHELL_PROGS
                      else " ".join(words[1:]) if prog == "eval" else None)
            if script and depth < _MAX_WRITE_NEST:
                inner_text, inner_docs = _split_heredocs(script)
                inner = _written_scripts(_split_on_operators(
                    inner_text, include_pipe=False, groups=True), inner_docs, depth + 1)
                for path, texts in inner.items():
                    written.setdefault(path, []).extend(texts)
            if stage.lstrip()[:1] in ("{", "("):
                # A group prints what ALL its statements print. Its first-word
                # reading is not that: `_strip_prefixes` drops the `{`.
                core = _group_core(stage)
                text = _statements_printed(_unwrap_group(core if core else stage)) or None
            elif text is None and prog not in _SCRIPT_READERS:
                # Any other stage writes what it is fed or a here-string gives
                # it, as near as the guard can tell: `… | cat - > f`, `| head
                # > f`, `| tr a b > f`, `cat > f <<< '…'` (XERK-1674).
                if "<<<" in stage:
                    fed = next(iter(_herestrings(stage)), None) or fed
                text = fed
                if fed and prog == "dd":
                    outs = outs + [posixpath.normpath(w[3:]) for w in words[1:]
                                   if w.startswith("of=")]
                elif fed and prog in ("cp", "install") and len(words) > 2 and any(
                        w in _STDIN_PATHS for w in words[1:-1]):
                    outs = outs + [posixpath.normpath(words[-1])]
            if prog == "tee" and fed:
                outs = outs + [posixpath.normpath(w) for w in words[1:] if not w.startswith("-")]
                text = fed
            for path in outs if text else ():
                written.setdefault(path, []).append(text)
            fed = text if text else None
    for owner, body, _quoted in heredocs:
        for seg in _split_segments(owner):
            if "<<" not in seg:
                continue
            words, outs = _stdout_targets(_strip_prefixes(_tokenize(seg)))
            if words and _basename(words[0]) == "tee":
                outs += [posixpath.normpath(w) for w in words[1:] if not w.startswith("-")]
            if words and _basename(words[0]) in ("cat", "tee"):
                for path in outs:
                    written.setdefault(path, []).append(body)
    return written


# A word that can run a file (a shell, `.`/`source`, a path), gating the
# write scan in `_expand`.
_MAY_RUN_FILE_RE = re.compile(r"sh|source|\.|/|xargs|exec|eval|PATH")
# What runs a file the guard cannot pin to a path the line writes, at a
# command start (a `-c` script's or a pipe stage's too): a shell reading
# stdin (`| sh`, `sh < f`, `bash -s`, `sh /dev/stdin`), `.`/`source`, `eval`,
# `xargs`, `hash`; and anywhere, `find -exec` or a `PATH=` change. A shell
# given a file is the segment loop's; a word elsewhere (`git add .`, "bash"
# in a note) is text.
_CMD_START = (r"(?:^|[;&|({`\n'\"]|\b(?:then|do|else|elif|if|while|until|exec|env|sudo|"
              r"nohup|command|builtin|time|timeout\s+\S+)\s)\s*"
              r"(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*")
_RUNS_UNNAMED_RE = re.compile(
    _CMD_START + r"(?:[^\s;&|'\"]*/)?(?:(?:(?:ba|da|z|k|a)?sh|busybox)"
    r"(?=[ \t]*(?:$|[;&|)<'\"\n]|-[a-zA-Z]*s\b|-\s|/dev/|/proc/))"
    r"|(?:source|\.|eval|xargs|hash)(?=$|[\s;&|)<'\"]))"
    r"|\s-(?:exec|execdir|ok|okdir)\b|\bPATH\+?=")
# A shell's `-c` script, an `eval`, a `trap` action or a function body,
# whose runs the segment loop never pairs with this line's writes.
_C_OR_EVAL_RE = re.compile(_CMD_START + r"(?:[^\s;&|'\"]*/)?(?:(?:ba|da|z|k|a)?sh\s[^;&|\n]*-[a-zA-Z]*c|eval)\b"
                           r"|\(\s*\)\s*[{(]|\btrap\s")
# A command that may copy a file to another path (`cp f g; ./g`).
_COPIES_RE = re.compile(r"(?<![\w.-])(?:cp|mv|ln|install|rsync|dd|tar|unzip|gcp)(?![\w.-])"
                        r"|\bcat\s+[^-\s<>|;&)][^;&|\n)]*(?:>|\|\s*tee\b)")
# Words a sourced written file's parameters are bound to.
_MAX_LINE_WORDS = 32
# Two positional parameters in one word (`"$1/$2"`, `$1$2`).
_GLUED_PARAMS_RE = re.compile(r"\$\{?[1-9@*]\}?[^\s;&|]*?\$\{?[1-9@*]")
# Paths a writer reads its stdin through (`cp /dev/stdin f`).
_STDIN_PATHS = {"-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"}
# How deep `_written_scripts` follows groups and compounds into their bodies.
_MAX_WRITE_NEST = 8
# Distinct argument lists one written file is read with, per line.
_MAX_SCRIPT_RUNS = 8


def _script_file_readings(path: str, runs: list[tuple[str, ...]],
                          written: dict[str, list[str]],
                          line_words: tuple[str, ...] = ()) -> list[str]:
    """The texts the line's runs of written file ``path`` add, every run
    known (XERK-1641 QA). A run with no arguments reads the text as written;
    one with arguments reads it bound as a `sh -c` script is (its own `set
    --`/`shift` applied) — bound only, since unbound beside it doubled real
    scripts' cost toward "too large". Past `_MAX_SCRIPT_RUNS` distinct lists,
    ONE reading binds every parameter to every argument of every run, one
    word each: dropping later runs let a run after nine benign ones through.

    A run with no arguments may still see the caller's: a sourced file
    inherits `set -- …` and a function's `$@`, and a run the guard could not
    name had its arguments unread. So its text is also read with every
    parameter bound to every path-like word of the line (``line_words``,
    XERK-1674)."""
    out: list[str] = []
    argful = [a for a in runs if a]
    for text in written.get(path, ()):
        scripts = _script_readings(text)
        bound = [r for sc in scripts for r in _positional_readings(sc)]
        if len(argful) > _MAX_SCRIPT_RUNS:
            # Past the cap, the every-argument reading loses an unset
            # parameter's default, the script's own `set --` and a glued
            # `/$1`, so the unbound text and its `set --` readings are read
            # too (QA 6).
            every = list(dict.fromkeys(a for r in argful for a in r))
            out += scripts + bound
            out += [_bind_positionals(sc, [path, *every], every=True) for sc in (*scripts, *bound)]
            # ...and a glued `"$1/$2"` is not one word per parameter there, so
            # each parameter it uses is read as each argument with the others
            # empty: `sh x.sh "" etc` is `/etc` (XERK-1674). Charged: a
            # budget past this is refused as too large.
            for sc in scripts:
                if not _GLUED_PARAMS_RE.search(sc):
                    continue
                for k in sorted({int(n) for n in re.findall(r"\$\{?([1-9])", sc)}):
                    for word in every:
                        _spend(len(sc))
                        args = [path, *[""] * 9]
                        args[k] = word
                        out.append(_bind_positionals(sc, args))
            continue
        if len(argful) < len(runs):
            out += scripts
            if line_words:
                out += [_bind_positionals(sc, [path, *line_words], every=True)
                        for sc in scripts if "$" in sc]
        for args in argful:
            argv = [path, *args]
            out += [b for b in dict.fromkeys(_bind_positionals(sc, a)
                                             for sc in (*scripts, *bound)
                                             for a in _shifted(argv, sc))]
    return list(dict.fromkeys(out))


def _script_file(prog: str, rest: list[str]) -> str | None:
    """The script file a shell (no `-c`) or `source`/`.` runs, normalised; a
    shell with no file operand reads the file redirected to its stdin."""
    words, _ = _stdout_targets(rest)
    if prog in ("source", "."):
        return posixpath.normpath(words[0]) if words else None
    if _shell_c_index(words) >= 0:
        return None
    i = 0
    while i < len(words) and words[i][:1] in "-+" and len(words[i]) > 1:
        if words[i] == "--":
            i += 1
            break
        i += 2 if words[i] in _SHELL_OPTS_WITH_VALUE else 1
    if i < len(words):
        return posixpath.normpath(words[i])
    for k, tok in enumerate(rest):
        if tok in ("<", "0<") and k + 1 < len(rest):
            return posixpath.normpath(rest[k + 1])
        m = re.match(r"0?<([^<&(>].*)", tok)
        if m:
            return posixpath.normpath(m.group(1))
    return None


def _expand_segments(command: str, depth: int = 0,
                     cwds: tuple[str, ...] = ()) -> list[tuple[list[str], str]]:
    """`_expand`, reporting a spent growth budget as `_TOO_LARGE`."""
    if depth:
        return _expand(command, depth, cwds)
    return list(_budgeted(_memo)("expand", (command, cwds), _expand_top, command, cwds))


def _expand_top(command: str, cwds: tuple[str, ...]) -> list[tuple[list[str], str]]:
    try:
        return _expand(command, 0, cwds)
    except _ExpansionTooLarge:
        return [([_TOO_LARGE], command)]


def _expand(command: str, depth: int, cwds: tuple[str, ...]) -> list[tuple[list[str], str]]:
    """Every command ``command`` would actually run, as (tokens, segment) pairs.

    Splitting on shell operators alone only ever saw the OUTERMOST command, so
    `bash -c 'rm -rf /etc'`, `(rm -rf /etc)`, `$(rm -rf /etc)`, `eval '...'`,
    `xargs rm -rf` and `find / -exec rm -rf {} +` each classified as something
    harmless and sailed past every destructive check. Each of those forms is
    unwrapped here and its inner command classified on its own terms.
    """
    out: list[tuple[list[str], str]] = []
    if depth > _MAX_EXPAND_DEPTH:
        return [([_TOO_DEEP], command)]
    if _budget is not None and time.monotonic() > _budget["until"]:
        _budget["left"] = -1
        raise _ExpansionTooLarge
    # bash drops a `\\<newline>` before it expands anything, so `$\\<newline>v`
    # is `$v`; read apart, `$` and `v` hid the value (XERK-1662). An ADDED
    # reading of the joined text: the raw one stays. Then, once nothing but
    # single-quoted ones are left, with those joined too, as the `eval` or
    # `bash -c` that re-parses the quoted text joins them. Each step leaves
    # fewer to join, so this recurses at most twice.
    if "\\\n" in command and "$" in command:
        joined = _join_continuations(command)
        if joined == command:
            joined = command.replace("\\\n", "")
        if joined != command:
            _spend(len(joined))
            out.extend(_expand(joined, depth, cwds))
    # Before any reader: an assigned value read first kept `a=$x$(echo rm …)`
    # as `$xrm …` (see `_brace_glued_names`). An ADDED reading, never swapped
    # in: a re-parse can join what the brace split — `eval "\$x$(echo y) rm …"`
    # runs `$xy rm …`, its substitution already run a level up — so the text
    # is also read unbraced, with no bracing beneath (XERK-1615 QA).
    braced = _brace_glued_names(command)
    # A quote-ended name's brace (`_brace_quote_ended`) needs no unbraced reading.
    if braced != command and (not _BRACE_GLUED[0] or _GLUED_NAME_RE.search(command)):
        _spend(len(command))
        _BRACE_GLUED[0] = False
        try:
            out.extend(_expand(command, depth, cwds))
        finally:
            _BRACE_GLUED[0] = True
    command = braced
    # Groups first, over the whole command: splitting below would sever any
    # group whose body holds an operator (see _balanced_groups). Scanned
    # BEFORE pre-normalisation, whose brace expansion ignores quoting and can
    # unbalance them (`awk '{print $2, $4}'`); each body gets the variables
    # this line assigns, so `d=/etc; (true; rm -rf $d)` still resolves.
    raw_line = command
    raw_commands, heredocs = _split_heredocs(command)
    raw_vals = _var_values(raw_commands)
    for reading in _reader_extra_readings(raw_line, raw_commands, heredocs, raw_vals):
        out.extend(_expand(reading, depth, cwds))
    # Every directory a `cd` before a command (on this line or an enclosing
    # one) may have moved it into. SCOPE-blind on purpose — a later `cd` never
    # clears one: it can fail, sit in a subshell or pipe, or be `cd -`, and
    # clearing let `cd /; (cd /tmp); rm -rf *` through (XERK-1549). Order
    # counts only on a line where nothing can run AGAIN: a trailing `cd /` must
    # not turn an earlier `chmod -R go-w .` into `/.`. A loop, function,
    # alias, trap or eval can re-run earlier text after a later `cd`, and
    # finding where such a body ends lost to bash's grammar twice (a stack of
    # open bodies, then a region scanner: `done=1`, `f() if …`, `${a:-${b}}`).
    # So any sign of one, anywhere, makes the whole line order-blind.
    every_cd = _cd_readings(_prenormalise(raw_commands), cwds)
    if every_cd != cwds and _REPLAYS_RE.search(command):
        cwds = every_cd
    bodies, suspect = _balanced_groups(raw_commands)
    # Every heredoc on one line shares that whole line as its owner, so the
    # pipes-into-a-shell scan below is memoised on the owner string — re-running
    # it per heredoc was O(heredocs × stages) and hung a 2000-heredoc line.
    owner_pipes_to_shell: dict[str, bool] = {}
    # ...and so is the whole-line scan a group redirect falls back to, which is
    # the same for every owner: per owner it was O(heredocs × segments).
    line_feeds_shell: list[bool] = []
    # Functions and aliases the line defines, which may run a shell (XERK-1624).
    defined_names: list[frozenset[str]] = []

    def _defined() -> frozenset[str]:
        if not defined_names:
            defined_names.append(_defined_names(raw_commands))
        return defined_names[0]

    def _commands_feed_shell() -> bool:
        if not line_feeds_shell:
            line_feeds_shell.append(_line_feeds_shell(raw_commands))
        return line_feeds_shell[0]
    for owner, body, quoted in heredocs:
        # A heredoc fed to a SHELL is a script, not data — `bash <<EOF ... EOF`
        # runs every line of it. Expand those bodies as commands; bodies fed to
        # anything else stay data (see _destructive_database for the psql case).
        owner_tokens = _strip_prefixes(_tokenize(_SUBST_RE.sub(" ", owner)))
        def _owner_feeds_shell() -> bool:
            # So is one whose `<<` sits on a shell further in than the line's
            # first word, one that PIPES into a shell (`cat <<'EOF' | bash`,
            # XERK-1539), or one on a group holding a shell (XERK-1618).
            # Memoised on the owner string (every heredoc on a line shares it)
            # and reached only when the cheap head check below misses, so a
            # `bash <<EOF` owner never pays for this scan.
            if owner not in owner_pipes_to_shell:
                owner_pipes_to_shell[owner] = _heredoc_owner_feeds_shell(
                    owner, _commands_feed_shell,
                    lambda w: _owner_word_may_be_shell(w, raw_vals, _defined()),
                    lambda st: _stage_may_read_stdin(st, raw_vals, _defined()))
            return owner_pipes_to_shell[owner]
        if (owner_tokens and _basename(owner_tokens[0]) in _SCRIPT_READERS
                or _owner_feeds_shell()):
            for script in ([body] if quoted else _heredoc_readings(body)):
                # ...and cut, before the splice runs a value together (XERK-1620).
                # Nested, each level doubles the cost; that is accepted, since it
                # needs a cuttable assignment at every level and the deadline
                # denies. A flag to skip nested cuts let one heredoc that needs
                # its cut hide the next (XERK-1620 QA).
                unsplit = _unsplit_assignments(script)
                if unsplit != script:
                    _spend(len(unsplit))
                    out.extend(_expand_segments(_substitute_vars(unsplit, raw_vals), depth + 1,
                                                every_cd))
                # ...and so is an assignment its substitutions print (XERK-1645
                # QA), whichever shell runs them: a quoted body's own shell does.
                for cut in _printed_unsplit(script, unsplit):
                    out.extend(_expand_segments(_substitute_vars(cut, raw_vals), depth + 1,
                                                every_cd))
                # ...and its own `-c`/eval scripts walked raw. Here the owner is
                # judged by `_owner_feeds_shell` (`bash<<'E'`, `{ bash; } <<'E'`,
                # `$x <<'E'`, a heredoc in `$(…)`); the line's walk sees nesting.
                if quoted:
                    for cut in _raw_printed_cuts(script):
                        out.extend(_expand_segments(cut, depth + 1, every_cd))
                out.extend(_expand_segments(_substitute_vars(script, raw_vals), depth + 1,
                                            every_cd))
        elif not quoted:
            # ...but data behind an UNQUOTED delimiter is expanded first, so its
            # `$(…)` and backticks run whoever reads it: `cat <<EOF` / `$(rm -rf
            # /)` / `EOF` deletes / (XERK-1256). A lost scan fails closed, as
            # the command line's own does below.
            found, lost = _balanced_groups(body, heredoc=True)
            bodies.extend(found)
            if lost:
                for raw in _split_segments(body):
                    for frag in _stray_group_fragments(raw):
                        out.extend(_expand_segments(frag, depth + 1, cwds))
    # What the group pass below already expanded, so the per-segment
    # substitution pass skips the same body at the same cwds: both reach every
    # outermost `$(…)`, and expanding it twice per level was 2^depth work.
    expanded: set[tuple[str, tuple[str, ...]]] = set()
    for body in bodies:
        if _ARITH_BODY_RE.match(body):
            continue
        interior = _arith_interior(body)
        if interior is not None and "$(" + body + ")" in raw_commands:
            # `$((…))` runs no command of its own, only the substitutions in
            # it, whose output is an operand: read as `:`'s ARGUMENTS, so a
            # taint reading there is never a program (XERK-1617 replay:
            # `$(( $(stat -c%s f || echo 0)/1048576 ))`).
            body = ": " + interior
        before = cwds
        if every_cd != cwds:
            # The `cd`s written before the group are the ones it runs after.
            head = raw_commands[:max(raw_commands.find(body), 0)]
            before = _cd_readings(_prenormalise(head), cwds)
        body = _substitute_vars(body, raw_vals)
        expanded.add((body, before))
        out.extend(_expand_segments(body, depth + 1, before))
    # A function's `$1`… bound to each call's words and the line's to each
    # `set --`'s (XERK-1626): read beside the unbound text, never instead.
    # Its own assignments win: the line's `d=$1` is the unbound value.
    # Memoised per decision: every re-reading of the line (each splice,
    # value and taint pass) yields the same bound span again, and a looped
    # `set -- "$@" x` re-expanded one 104 times (6x main).
    for reading in _positional_readings(raw_commands):
        vals = {**raw_vals, **_var_values(reading)}
        bound = _substitute_vars(reading, vals)
        out.extend(_memo("expand", ("positional", bound, depth, every_cd),
                         _expand_segments, bound, depth + 1, every_cd))
        # A bound `$1` is spliced in as text, so a set IFS cannot split it
        # there: `IFS=,; set -- rm,-rf,/etc; $1` (XERK-1662). Read with every
        # IFS character a blank too — over-reads its literal text, and only
        # on a line that sets IFS.
        split = _ifs_split_re(vals)
        if split is not None and split.search(bound):
            bound = split.sub(" ", bound)
            out.extend(_memo("expand", ("positional", bound, depth, every_cd),
                             _expand_segments, bound, depth + 1, every_cd))
        # A `for v; do $v` / `for v in "$@"` list is the bound words, each run
        # alone as the top line's lists are (`_for_word_lines`): joined,
        # `set -- a 'rm …'; for v; do $v; done` ran program `a` (XERK-1657).
        lines, too_large = _for_word_lines(reading, 1) if _FOR_IN_RE.search(reading) else ([], False)
        if too_large:
            out.append(([_TOO_LARGE], reading))
        for line, pick in lines:
            outer = _FOR_PICK[0]
            _FOR_PICK[0] = pick
            try:
                line = _substitute_vars(line, {**raw_vals, **_var_values(line)})
                out.extend(_memo("expand", ("positional", line, depth, every_cd),
                                 _expand_segments, line, depth + 1, every_cd))
            finally:
                _FOR_PICK[0] = outer
    command = _prenormalise(raw_commands)
    segments = _split_segments(command)
    # ...and what a substitution whose body holds an operator PRINTS is text
    # the line runs, but segmenting cut it in half (`$(true` / `echo rm -rf
    # /etc)`) before `_subst_text` could read it (XERK-1609). So the line is
    # also split with each such substitution replaced by its output, adding
    # only the segments that differ. A printed text holding a substitution is
    # left to the bodies' own pass: re-reading it here re-expanded every level
    # of a nest again and multiplied the cost by its depth.
    unprinted = printed_line = _brace_glued_names(raw_commands)
    for body in bodies:
        if not _SEGMENT_SPLIT.search(body):
            continue
        printed, escaped = _body_printed(body, _reading())
        _SPLICES_ESCAPED[0] += escaped
        if printed and "$(" not in printed and "`" not in printed:
            for whole in ("$(" + body + ")", "`" + body + "`"):
                printed_line = printed_line.replace(whole, printed)
    if printed_line != unprinted:
        # Its lines are commands to a shell that re-parses them, and words
        # where the line word-splits them (`$(echo rm -rf; echo /etc)`).
        seen = set(segments)
        for line in dict.fromkeys((printed_line, printed_line.replace("\n", " "))):
            for seg in _split_segments(_prenormalise(line)):
                if seg not in seen:
                    seen.add(seg)
                    segments.append(seg)
        # Those segments run AFTER the ones they came from, so a `cd` among
        # them (`cd $(echo /; true); rm -rf *`) moves the whole line, in order
        # or not: the half-segment `cd $(echo /` named no directory.
        cwds = _cd_readings(_prenormalise(printed_line), cwds)
    # A leading assignment shlex would split hides the command after it, so
    # the line's segments are ALSO read with each cut to its `NAME=`, adding
    # only those that differ (XERK-1620). Never the whole line re-expanded:
    # its bodies are unchanged, and re-reading them at every nesting level
    # doubled the cost per level.
    unsplit = _unsplit_assignments(raw_commands)
    unsplit_line = ""
    if unsplit != raw_commands:
        _spend(len(unsplit))
        unsplit_line = _prenormalise(unsplit)
        seen = set(segments)
        for seg in _split_segments(unsplit_line):
            if seg not in seen:
                seen.add(seg)
                segments.append(seg)
    # ...and one a substitution PRINTS: `bash -c "$(echo 'X=${v:-a b}') rm …"`
    # re-parses `X=${v:-a b} rm …`, but the cut above ran on the raw line and
    # the re-parse substitutes `a b` before its own cut can see it (XERK-1645).
    # So the line with each substitution's printed text spliced in is cut too,
    # adding its segments and pipelines only where the raw line's cut missed.
    # ...and in each `-c`/eval script the line runs, read off the RAW text: a
    # nested level is handed its script with `${…}` already substituted, so
    # `bash -c 'eval $(echo …X=${v:-a b}…) rm …'` reached it as `X=a b`.
    if "$(" in raw_line or "`" in raw_line or "$'" in raw_line:
        for cut in _raw_printed_cuts(raw_line):
            out.extend(_expand_segments(cut, depth + 1, every_cd))
        for cut in _printed_unsplit(raw_commands, unsplit):
            cut_line = _prenormalise(cut)
            unsplit_line = f"{unsplit_line}\n{cut_line}" if unsplit_line else cut_line
            seen = set(segments)
            for seg in _split_segments(cut_line):
                if seg not in seen:
                    seen.add(seg)
                    segments.append(seg)
    # ...and with each expansion's value glued into one word, before anything
    # splices it: an eval, pipe, printed or `source <(…)` join of
    # `X=${v:-a b}` with the command is one assignment to bash (XERK-1684).
    # Only the segments, pipelines and `<(…)` texts that differ are added, as
    # for the cut line: a whole-line re-read doubled real nested scripts.
    # ANSI-C decoded too, so `${v:-a'$'\t''b}` shows its blank; not only,
    # since decoding drops the `$` of `'X=$''{v:-a b}'`.
    glued_lines: list[str] = []
    for plain in dict.fromkeys((raw_commands, _decode_ansi_c(raw_commands)
                                if "$'" in raw_commands else raw_commands)):
        for spelled in (True, False):
            glued = _glued_param_values(plain, raw_vals, spelled)
            if glued == plain or _prenormalise(glued) in glued_lines:
                continue
            _spend(len(glued))
            glued_lines.append(_prenormalise(glued))
            seen = set(segments)
            for seg in _split_segments(glued_lines[-1]):
                if seg not in seen:
                    seen.add(seg)
                    segments.append(seg)
    # ...and with each value split where a non-blank IFS the line sets splits
    # it: `x=rm,-rf,/etc; IFS=,; $x` runs `rm -rf /etc` (XERK-1662).
    split_vals = _ifs_split_values(raw_vals)
    if split_vals:
        _spend(len(raw_commands))
        seen = set(segments)
        for seg in _split_segments(_prenormalise(_substitute_vars(raw_commands, split_vals))):
            if seg not in seen:
                seen.add(seg)
                segments.append(seg)
    # The TAINT reading of every operator-holding substitution the splitter cut
    # (XERK-1613), rebuilt in ONE pass so a body of N statements stays linear.
    seen = set(segments)
    for tainted_line in _taint_readings(raw_commands, _taint_line_repl):
        if tainted_line == raw_commands:
            continue
        for line in dict.fromkeys((tainted_line, tainted_line.replace("\n", " "))):
            for seg in _split_segments(_prenormalise(line)):
                if seg not in seen:
                    seen.add(seg)
                    segments.append(seg)
    # `xargs` takes its operands from the PIPE, not its own argv, so
    # `echo /etc | xargs rm -rf` carries the target in a sibling segment.
    # Collect every path-shaped operand in the command so an xargs segment can
    # be judged against what is actually going to be fed to it.
    piped_operands: list[str] = []
    for raw in segments:
        toks = _tokenize(raw)
        for tok in toks:
            if not tok.startswith("-") and ("/" in tok or tok in ("~", ".", "..")):
                piped_operands.append(tok)
        # find prints every path it walks, all of `/` under `"$x/$y"` with both
        # unset, so `find "$x/$y" | xargs rm -rf` is fed `/`'s children (XERK-1687).
        lead = _strip_prefixes(toks)
        if lead and _basename(lead[0]) == "find":
            piped_operands += filter(None, (_unset_names_dropped(t, keep_last=False)
                                            for t in _find_roots(lead)))
    # Once each: a segment read several ways (a redirect joined and split,
    # XERK-1631) repeats its words.
    piped_operands = list(dict.fromkeys(piped_operands))
    piped_chars = sum(len(t) + 1 for t in piped_operands)
    # A shell that reads its SCRIPT from stdin runs whatever the pipeline,
    # a here-string or a `<(…)` feeds it — `echo '<cmd>' | sh`, `sh <<< '<cmd>'`,
    # `. <(echo '<cmd>')` — none of which is an argv of its own (XERK-1539).
    #
    # Walk each pipeline left to right ONCE, accumulating the DISTINCT texts
    # earlier stages print (a filter between passes them on). A fresh re-scan of
    # every earlier stage per reader was O(stages²) and a 60 KB `echo|sh` chain
    # took 15 min — past the hook timeout, which fails OPEN. De-duping and the
    # fed-text cap bound the work; a reader past the cap is a miss, never a hang.
    # Nothing feeds a shell a script without a pipe, here-string or `<(…)`
    # somewhere, so the whole scan (an extra full-command split) is skipped when
    # the line has none — a line of 1000 `bash <<EOF` heredocs otherwise paid
    # for it (the body is a script by the heredoc path above, not this one).
    feeds_a_shell = ("|" in command or "<<<" in command or "<(" in command
                     or ">(" in command  # `cmd > >(sh)` feeds the sub too (XERK-1628)
                     or "coproc" in command)  # `>&${COPROC[1]}` feeds a coproc (XERK-1717)
    # A `<(…)` operand is a FILE its stage reads, and `cat`, `tee`, `head` and
    # the like pass a file through: `cat <(echo <cmd>) | bash` runs <cmd>
    # (XERK-1611). Fed to EVERY reader on the line, whatever the program and
    # wherever the reader sits — failing closed — since the splits below are
    # not paren-aware and cut at a `|` or `;` inside one (`<(echo …; true)`).
    proc_subst_texts = [text for line in (command, *glued_lines) if "<(" in line
                        for m in _find_substs(line) if m.group(0).startswith("<(")
                        for text in _proc_subst_texts(_subst_inner(m))]
    # ...and so is what an `exec` opens on an fd for the rest of the line:
    # `exec 3<<<'<cmd>'; bash /dev/fd/3` (XERK-1614). Its `<(…)` is above.
    if "<<<" in command:
        proc_subst_texts += [hs for raw in segments
                             if [t for t in _tokenize(raw) if t not in ("command", "builtin")][:1]
                             == ["exec"]
                             for hs in _herestrings(raw)]
    # ...and a heredoc an `exec` holds on an fd for the rest of the line:
    # `exec 3<<EOF … EOF; bash <&3` runs the body (XERK-1628).
    for _owner, _body, _q in heredocs:
        first = [t for t in _tokenize(_SUBST_RE.sub(" ", _owner))
                 if t not in ("command", "builtin")][:1]
        if first == ["exec"]:
            proc_subst_texts.append(_body)
    # Every pipeline replays these, so de-dupe and cap them once, here: one
    # per `exec` made a line of n of them O(n²) (XERK-1614).
    proc_subst_texts = list(dict.fromkeys(proc_subst_texts))[:_FED_TEXT_CAP]
    # A line that opens an fd an `exec` feeds (no pipe needed) must be walked.
    feeds_a_shell = feeds_a_shell or bool(proc_subst_texts)
    # Split keeping groups whole: a cut inside `{ echo …; }` or `X=<(a; b)`
    # severs a producer from its reader (XERK-1614).
    # ...and ALSO split the plain way, as before groups were kept whole: a group
    # the scan keeps whole but cannot open (`{ (a; echo …) | sh; }`, `do (…)`)
    # hid a pipeline the plain split cut out. Reading both, the walk finds at
    # least what it found before; identical pipelines are walked once.
    pipelines = _walked_pipelines(command) if feeds_a_shell else []
    if unsplit_line and feeds_a_shell:
        # ...and the line read with its assignments cut (XERK-1620).
        pipelines = list(dict.fromkeys(pipelines + _walked_pipelines(unsplit_line)))
    for line in glued_lines if feeds_a_shell else ():
        # ...and with its values glued (XERK-1684).
        pipelines = list(dict.fromkeys(pipelines + _walked_pipelines(line)))
    # Functions the line defines, so a call in a pipeline runs its body.
    func_bodies = (_function_bodies(command)
                   if feeds_a_shell and ("(" in command or "function" in command) else {})
    def _stage_reads(stage: str) -> bool:
        # Named as bash forms it before the group is unwrapped (XERK-1629).
        # ...and a program word that is not literal read as the heredoc
        # owner's is: `| $SHELL`, `| /bin/ba?h`, an alias (XERK-1632).
        return (any(_reads_stdin_script(_unwrap_group(t)) for t in _name_readings(stage))
                or ((_defined() or _NONLITERAL_RE.search(stage))
                    and _stage_may_read_stdin(stage, raw_vals, _defined(), checked=True)))

    def _stage_emits(ustage: str) -> list[str]:
        # What a stage prints to whatever reads its stdout. A producer behind
        # a prefix (`sudo echo …`, `time printf …`) still prints, so strip
        # them before reading what it emits.
        texts: list[str] = []
        for seg in _simple_commands(ustage):
            texts.append(_printed_from_tokens(_strip_prefixes(_tokenize(seg))) or "")
            # ...and with its substitutions run: tokenising first split a
            # nested backtick at its escaped inner opener (XERK-1605).
            texts.append(_printed_text(_sub_substs(seg, _subst_text)) or "")
            # ...and with an unknown one glued to its program read as
            # empty: `$(true)echo rm -rf / | sh` runs `echo` (XERK-1621).
            if "$(" in seg or "`" in seg:
                texts.append(_printed_text(_sub_substs(
                    seg, lambda m: _subst_text(m, glued_empty=True))) or "")
            texts.extend(_herestrings(seg))
        return texts

    if "coproc" in command:
        # A coproc's command reads its stdin from an fd the rest of the line
        # may write by any route — `>&${COPROC[1]}`, `>&"${S[1]}"`, an `exec
        # 5>&${S[1]}` copy, `fd=${S[1]}; >&$fd`, `/dev/fd/N`, `/proc/self/fd/N`
        # — so which writer reaches it can't be traced. As for a file run
        # unpinned (XERK-1674) it fails closed: EVERY text the line prints is
        # fed to a coproc that may read a script from stdin (XERK-1717).
        # Accepted over-deny: a shell coproc beside an echo of a destructive
        # command written somewhere else.
        stages = list(dict.fromkeys(
            stage for pipeline in pipelines
            for stage in _split_on_operators(pipeline, keep_redirects=True, groups=True)))
        if any("coproc" in _tokenize(stage) and _stage_reads(stage)
               for stage in stages):
            fed_coproc = list(dict.fromkeys(
                t for stage in stages for t in _stage_emits(_unwrap_group(stage))))
            for text in [t for t in fed_coproc if t.strip()][:_FED_TEXT_CAP]:
                for script in _script_readings(text):
                    out.extend(_expand_segments(script, depth + 1, every_cd))
    for pipeline in pipelines:
        # A single-stage "pipeline" with no here-string or `<(…)` has nothing
        # feeding it either, so skip its per-stage scan too — unless the line
        # opened an fd it may read (`exec 3< <(…); bash <&3`).
        if (not proc_subst_texts and "|" not in pipeline and "<<<" not in pipeline
                and "<(" not in pipeline and ">(" not in pipeline):
            continue
        producers: list[str] = []       # distinct printed/here-string texts so far
        seen_texts: set[str] = set()
        def _feed(text: str) -> None:
            if text and text.strip() and text not in seen_texts \
                    and len(seen_texts) < _FED_TEXT_CAP:
                seen_texts.add(text)
                producers.append(text)
        for text in proc_subst_texts:
            _feed(text)
        for stage in _split_on_operators(pipeline, keep_redirects=True, groups=True):
            ustage = _unwrap_group(stage)
            # A call to a function the line defines runs its body, which may
            # read stdin or print the fed text; arguments bind to `$1…` the
            # body may ignore, so resolve whatever the call's args (XERK-1628).
            # Chase a body that is itself a bare call (`f(){ g; }; g(){ bash; }`).
            seen_fn = 0
            while func_bodies and seen_fn <= _MAX_EXPAND_DEPTH:
                call = _strip_prefixes(_tokenize(ustage))
                if call and _basename(call[0]) in func_bodies:
                    stage = ustage = func_bodies[_basename(call[0])]
                    seen_fn += 1
                else:
                    break
            # `cmd > >(reader)`: the reader consumes this stage's stdout, so it
            # runs that output as a script — `echo … > >(sh)` (XERK-1628).
            for m in _find_substs(ustage):
                if m.group(0).startswith(">(") and _reads_stdin_script(_subst_inner(m)):
                    toks = _strip_prefixes(_tokenize(ustage))
                    cut = next((k for k, t in enumerate(toks)
                                if t.startswith(">(") or _REDIR_WORD.match(t)), len(toks))
                    emitted = _printed_from_tokens(toks[:cut]) or ""
                    for text in list(producers) + [emitted]:
                        if text.strip():
                            for script in _script_readings(text):
                                out.extend(_expand_segments(script, depth + 1, every_cd))
            if _stage_reads(stage):
                fed = list(producers)
                fed.extend(_herestrings(ustage))
                for m in _find_substs(ustage):
                    if m.group(0).startswith("<("):
                        fed.extend(_proc_subst_texts(_subst_inner(m)))
                for text in fed:
                    if text.strip():
                        # shlex keeps a double-quoted `\\$` bash drops: `bash
                        # <<< "\\$x rm …"` runs an unset `$x` (XERK-1615).
                        for script in _script_readings(text):
                            out.extend(_expand_segments(script, depth + 1, every_cd))
            # This stage's own contribution to readers DOWNSTREAM of it.
            for text in _stage_emits(ustage):
                _feed(text)
    if _ALIASES_ON[0] and "alias" in raw_commands:
        # An alias runs its VALUE with the use's words after it: `alias
        # b='bash -c'; b '<cmd>'`, through a chain, an `eval "b …"` or a pipe
        # (XERK-1641 QA). Read as ONE added reading of the line per value
        # index, every use replaced; per use it was (definitions × uses).
        for aliased in _aliased_readings(raw_commands):
            _spend(len(aliased))
            _ALIASES_ON[0] = False
            try:
                out.extend(_expand_segments(aliased, depth + 1, cwds))
            finally:
                _ALIASES_ON[0] = True
    # Files the line writes text into, which a later `sh f` runs (XERK-1555).
    runs_seen: dict[str, dict[tuple[str, ...], None]] = {}
    # Computed on the first segment that runs a script FILE: per `_expand`
    # call it re-split every line holding `>` and "sh" (most of them).
    written: dict[str, list[str]] | None = None if (
        (">" in command or "tee" in command or "of=" in command or "/dev/" in command)
        and _MAY_RUN_FILE_RE.search(command)) else {}
    # A run of a file that is not exactly a path the line writes (`sh "$PWD"/f`,
    # `cp f g; sh g`): fails closed, every written file read (XERK-1674).
    unresolved: dict[tuple[str, ...], None] = {}
    sources = False
    for raw in segments:
        if every_cd != cwds:
            cwds = _cd_readings(raw, cwds, raw_vals)
        # Function headers closed up (`f ( ) {` → `f() {`), as one more ADDED
        # reading: in place, an extglob `@()`, or a `()` the guard itself
        # splices in from a printed `` `echo '()'` ``, read as a header and hid
        # the command before it. Off the RAW segment, before any substitution
        # is spliced in, and per segment: re-reading the whole line doubled
        # the work at every nesting level (XERK-1633 QA).
        glued = _glue_func_parens(raw)
        if glued != raw:
            _spend(len(raw))
            out.extend(_expand_segments(
                glued, depth if _glue_func_parens(glued) == glued else depth + 1, cwds))
        if suspect:
            # The group scan lost track, so a body it should have found may
            # sit here split in half (see _balanced_groups): classify the
            # halves too.
            for frag in _stray_group_fragments(raw):
                out.extend(_expand_segments(frag, depth + 1, cwds))
        # Anything a substitution would run, wherever it sits in the segment.
        for m in _find_substs(raw):
            inner = _subst_inner(m)
            if inner.strip() and (inner, cwds) not in expanded:
                out.extend(_expand_segments(inner, depth + 1, cwds))
        # A substitution also CONTRIBUTES text where it sits — `$(echo …)` is
        # what `eval "$(echo rm -rf /etc)"` runs and what `rm -rf $(echo /etc)`
        # deletes. Both fall out of substituting rather than erasing.
        seg = _unwrap_group(_sub_substs(raw, _subst_text))
        # ...and one that printed nothing leaves the word it is glued to.
        bare = _unwrap_group(_sub_substs(raw, lambda m: _subst_text(m, glued_empty=True)))
        if bare != seg and bare:
            out.extend(_expand_segments(bare, depth + 1, cwds))
        # XERK-1609's extra readings of the same segment, each only ADDED:
        # the two above as read before several statements were (see
        # `_body_printed`); printed text as the literal word bash splices in,
        # so a printed `"` cannot close the string around it; and an unset
        # variable glued to a word read as that word.
        readings = {
            _unwrap_group(_sub_substs(raw, lambda m: _subst_text(m, multi=False))),
            _unwrap_group(_sub_substs(
                raw, lambda m: _subst_text(m, glued_empty=True, multi=False))),
            _unwrap_group(_sub_substs(raw, lambda m: _subst_text(m, literal=True))),
            # ...and a filtered or partly-unread substitution read as the text
            # its producers emit (XERK-1613); a non-cut one is read here, a cut
            # one by the line pass above.
            *(_unwrap_group(t) for t in _taint_readings(raw, _taint_subst)),
        }
        readings.update(_unset_readings(seg))
        if "${" in seg:
            # Positionals no binding reached are unset, so an operator's
            # default is the word: `rm -rf "${1:-/etc}"` (XERK-1636). Added
            # beside the bound readings, which see the text unapplied.
            readings.add(_unwrap_group(_bind_positionals(seg, [None])))
        readings.update(_decoy_readings(raw))
        for reading in readings - {seg, bare, ""}:
            out.extend(_expand_segments(reading, depth + 1, cwds))
        # An `eval`'s words joined as eval re-parses them, read off the RAW
        # segment (XERK-1585). The substitution pass above swallowed a QUOTED
        # `'$('` that the join makes live (`eval echo '$(' rm -rf / ')'`), and
        # collapsing `eval eval …` (below) skipped a parse: the `\\\;` in
        # `eval eval echo \\\; rm -rf /` is an operator only to the SECOND
        # eval, which this reaches by recursing once per eval (bounded by
        # _MAX_EXPAND_DEPTH, which fails closed).
        words = _strip_prefixes(_tokenize(_unwrap_group(raw)))
        if len(words) > 1 and _basename(words[0]) == "eval":
            # bash's eval takes (and drops) `--`.
            joined = " ".join(words[2:] if words[1] == "--" else words[1:])
            # `eval "$(echo 'a=$(…); $a')"` runs the printed text (XERK-1649).
            for script in dict.fromkeys([*_script_readings(joined), *_raw_script_texts(joined)[1:]]):
                out.extend(_expand_segments(script, depth + 1, every_cd))
                # ...with the line's values, where the join rebuilt a use the
                # line's own splice never saw: `eval '$'v`, `eval "$"v` run $v
                # (XERK-1657). The re-parse sees only this text, not the line.
                if raw_vals and _QUOTE_SPLIT_USE_RE.search(raw):
                    bound = _substitute_vars(script, raw_vals)
                    if bound != script:
                        out.extend(_expand_segments(bound, depth + 1, every_cd))
        # `seg` ran the line's substitutions, which turned a quoted `<(…)` —
        # literal to the outer shell — into the text it prints, so `bash -c
        # ". <(echo <cmd>)"` reached the inner parse as `. <cmd>`, a source of a
        # file named <cmd>. Re-read a shell's `-c` script with every `<(…)` left
        # as written, where the inner shell sees it (XERK-1611). Before the
        # operator split below: its `continue` skips a script holding `;`.
        if "<(" in raw:
            kept = _strip_prefixes(_tokenize(_unwrap_group(_sub_substs(
                raw, lambda m: m.group(0) if m.group(0).startswith("<(") else _subst_text(m)))))
            script = _shell_c_script(kept[1:]) if kept and _basename(kept[0]) in _SHELL_PROGS else None
            if script and "<(" in script:
                for reading in _script_readings(script):
                    out.extend(_expand_segments(reading, depth + 1, every_cd))
        # ...and with EVERY substitution left as written. A single-quoted `-c`
        # script runs its own `$(…)`, so `bash -c 'a=$(echo rm -rf /); $a'`
        # assigns the output whole; spliced in by the outer read it became
        # `a=rm -rf /; $a`, where `$a` is just `rm` (XERK-1622).
        # The same script handed over by `xargs` or `find -exec` (XERK-1649).
        if "$(" in raw or "`" in raw:
            kept = _strip_prefixes(_tokenize(_unwrap_group(raw)))
            for script in _raw_shell_c_scripts(kept):
                if "$(" in script or "`" in script:
                    for reading in _script_readings(script):
                        out.extend(_expand_segments(reading, depth + 1, every_cd))
        if seg != raw.strip() and seg:
            # A group/substitution-stripped body can itself hold operators.
            if _SEGMENT_SPLIT.search(seg):
                out.extend(_expand_segments(seg, depth + 1, cwds))
                continue
        tokens = _strip_prefixes(_tokenize(seg))
        if not tokens:
            continue
        if _UNREAD_OUTPUT in tokens[0] and len(tokens) > 1 and _taint_in_command_pos(seg):
            # A substitution's unread output names the program its printed words
            # are handed to (`$(basename /x/rm; echo -rf /etc)`): unknowable, so
            # refused rather than read as the harmless placeholder.
            out.append(([_UNREAD_PROG], seg))
            continue
        out.append((tokens, seg))
        prog = _basename(tokens[0])
        rest = tokens[1:]
        # `busybox` is stripped as a wrapper, which lost busybox itself as a
        # shell to the `-c` readings (`busybox script -qc '…'`). So the words
        # from it on are also read with it as `sh`: an ADDED reading (XERK-1687).
        raw_toks = _tokenize(seg)
        bb = next((i for i, t in enumerate(raw_toks[:len(raw_toks) - len(tokens)])
                   if _basename(t) == "busybox"), -1)
        if bb >= 0:
            out.extend(_expand_segments(
                " ".join(shlex.quote(t) for t in ["sh", *raw_toks[bb + 1:]]), depth + 1, cwds))
        # The file a shell or `.` runs, or one run by its path (`./s.sh`).
        script_path = (_script_file(prog, rest) if prog in _SHELL_PROGS or prog in ("source", ".")
                       else posixpath.normpath(tokens[0]) if "/" in tokens[0] else None)
        if (written is None or written) and script_path:
            if written is None:
                written = _written_scripts(
                    _split_on_operators(command, include_pipe=False, groups=True), heredocs)
            words = _stdout_targets(tokens)[0]
            at = next((k for k, w in enumerate(words) if k and posixpath.normpath(w) == script_path),
                      0 if words and posixpath.normpath(words[0]) == script_path else -1)
            args = tuple(words[at + 1:] if at >= 0 else ())
            # Recorded here, read once after the loop: every run of the file
            # on the line must be known before deciding how to read it.
            if script_path not in written:
                # The written file of that name: `$S/run.sh` written and
                # run with `$S` spliced, `"$PWD"/f`, or after a `cd`.
                base = posixpath.basename(script_path)
                script_path = next((w for w in written if posixpath.basename(w) == base),
                                   script_path)
            if prog in ("source", "."):
                sources = True
            if script_path in written:
                runs_seen.setdefault(script_path, {})[args] = None
            elif prog in (*_SHELL_PROGS, "source", ".") or re.search(r"[*?\[]", script_path) \
                    or _COPIES_RE.search(raw_commands):
                # A run of some other file, which may be a copy of one the
                # line wrote, or a path built from a value: fails closed.
                unresolved.setdefault(args, None)
        if prog in ("rm", "unlink", "chmod", "chown"):
            # `cd /; rm -rf *` deletes `/*`, which `rm` alone never names.
            for cwd in cwds:
                joined = [_under_cwd(t, cwd) for t in rest]
                if joined != rest:
                    out.append(([tokens[0], *joined], seg, False, cwd))
        # A shell named through `$SHELL`, an unset `$x`, a glob or an alias /
        # function the line defines may run its `-c` script too (XERK-1632).
        if prog in _SHELL_PROGS or (
                prog not in _SCRIPT_READERS and _shell_c_index(rest) >= 0
                and _owner_word_may_be_shell(tokens[0], raw_vals, _defined())):
            script = _shell_c_script(rest)
            if script is not None:
                scripts = _script_readings(script)
                # ...and again with its arguments bound, where it reads them.
                args = rest[_shell_c_script_index(rest) + 1:]
                # Each function call and `set` in it bound first (XERK-1626), so
                # `f() { rm -rf "$1"; }; f "$2"` reads `rm -rf "$2"`, then `/etc`.
                bound = [r for sc in scripts for r in _positional_readings(sc)]
                scripts += [b for b in (_bind_positionals(sc, a)
                                        for sc in (*scripts, *bound)
                                        for a in _shifted(args, sc))
                            if b not in scripts]
                for reading in scripts:
                    out.extend(_expand_segments(reading, depth + 1, every_cd))
        elif prog == "eval" and rest:
            # `eval eval eval … rm -rf /etc` is valid shell. Collapse the chain
            # ITERATIVELY — recursing once per `eval` burned the depth budget,
            # and exhausting it used to fail open.
            inner = rest
            # `eval -- '<cmd>'`: bash's eval takes (and drops) `--`.
            while inner and (_basename(inner[0]) == "eval" or inner[0] == "--"):
                inner = inner[1:]
            if inner:
                # Two readings, both expanded — branching between them on token
                # COUNT was wrong, because a redirection is a token too and
                # `eval '<cmd>' > /dev/null` then took the argv branch, where
                # quoting folded the payload into one word.
                #
                # 1. The whole argv, re-QUOTED so grouping survives: shlex.split
                #    has already dropped the quotes, and a plain join turned
                #    `eval bash -c 'rm -rf /etc'` into `bash -c rm -rf /etc`,
                #    where `-c`'s argument is the bare word `rm`.
                out.extend(_expand_segments(
                    " ".join(shlex.quote(t) for t in inner), depth + 1, every_cd))
                # 2. The FIRST token, when it is itself a command line. A quoted
                #    script is one token and keeps that shape whatever follows
                #    it, so this covers the redirection case above.
                #    Only the first: in `eval <cmd> <args…>` the trailing tokens
                #    are ARGUMENTS, and expanding those classified
                #    `eval echo 'rm -rf /etc'` — which prints text and deletes
                #    nothing — as destructive. That is the "commit message
                #    mentioning rm -rf" class this file exists not to refuse.
                if inner[0].strip() and re.search(r"\s", inner[0]):
                    out.extend(_expand_segments(inner[0], depth + 1, every_cd))
                # 3. The words joined bare, as eval itself re-parses them: an
                #    escaped `\;` is an operator again (`eval echo \; rm -rf /`).
                if len(inner) > 1:
                    out.extend(_expand_segments(" ".join(inner), depth + 1, every_cd))
        elif prog == "alias" and rest:
            # `alias f='rm -rf *'` runs wherever `f` is used — after any `cd`.
            for tok in rest:
                if "=" in tok:
                    out.extend(_expand_segments(tok.split("=", 1)[1], depth + 1, every_cd))
        elif prog == "trap" and rest:
            cwds = every_cd  # a handler runs after whatever `cd` comes later
            # `trap 'rm -rf /etc' EXIT` runs its handler on the way out. Scan
            # every non-flag argument, not just the first: `trap -- '<cmd>' EXIT`
            # displaces the handler by one and hid it completely.
            for tok in rest:
                if not tok.startswith("-"):
                    out.extend(_expand_segments(tok, depth + 1, cwds))
        elif prog in _EXEC_WRAPPERS and rest:
            # `ssh h 'rm -rf /'`, `docker exec c rm -rf /etc`,
            # `kubectl exec pod -- rm -rf /etc` were all allowed: a wrapper's
            # remote command was followed through for SQL (_stage_executes_sql)
            # but never expanded as a COMMAND, so the destructive and policy
            # rules never saw it. The remote host is a peer of this one — the
            # agent image ships ssh/docker/kubectl and mounts ~/.ssh — so this
            # is the same blast radius one hop away (XERK-235).
            #
            # Only two shapes are treated as the command, to keep an ordinary
            # `--label 'x=y z'` from being read as one: everything after `--`,
            # and any single argument that is itself a command line.
            # Single-vs-multi, exactly as `eval` does it. NOT "every argument
            # containing whitespace": that is the construct removed from eval
            # two rounds ago, and it reads `ssh host git commit -m 'rm -rf /etc
            # is banned'` as a destructive command.
            inner_cmd = _wrapper_command(prog, rest)
            if prog == "flock" and inner_cmd and inner_cmd[0] == "-c" and len(inner_cmd) > 1:
                # `flock <file> -c '<cmd>'` hands its OWN `-c` value to `sh -c`.
                # Only flock's — `-c` LEADING the command region, never a `-c`
                # among the inner command's args (`flock lk grep -c x`, where it
                # is grep's option; scanning every token false-denied that). The
                # `--command=`/`-xc` spellings util-linux rejects are left out.
                out.extend(_expand_segments(inner_cmd[1], depth + 1, cwds))
            if len(inner_cmd) == 1 and re.search(r"\s", inner_cmd[0]):
                out.extend(_expand_segments(inner_cmd[0], depth + 1, cwds))
            elif inner_cmd and prog in _JOINING_WRAPPERS:
                # ssh JOINS its operands and hands the string to a remote shell,
                # so `ssh host 'rm -rf /etc' 'b'` runs `rm -rf /etc b`.
                out.extend(_expand_segments(" ".join(inner_cmd), depth + 1, cwds))
            elif inner_cmd:
                out.extend(_expand_segments(
                    " ".join(shlex.quote(t) for t in inner_cmd), depth + 1, cwds))
            # ...and, because the option table above CANNOT be kept complete,
            # classify every non-option suffix as an argv too. Wherever the
            # command really starts, one of these begins at it, so a missing
            # option is a lost sharpening rather than a bypass. Safe to
            # over-approximate: a suffix starting in the wrong place yields a
            # program like `host` or a quoted message, which matches nothing.
            stop = False
            for idx in range(len(rest)):
                if stop or rest[idx].startswith("-"):
                    continue
                # n arguments emit n²/2 suffix words, each classified again:
                # 20k arguments took minutes (XERK-1589), so they share the budget.
                _spend(len(rest) - idx)
                tail = _strip_prefixes(rest[idx:])
                if len(tail) > 1:
                    out.append((tail, seg, True))
                # Everything after a program that only PRINTS is its arguments,
                # not another command: `ssh host echo rm -rf /etc` prints text,
                # and `docker run img printf 'x' rm -rf /etc` puts an argument
                # between the two. The printer's own suffix is emitted first, so
                # `ssh <unlisted-opt> v host git push origin main` still reaches
                # the policy rule.
                if _basename(rest[idx]) in _ARG_ONLY_PROGS:
                    stop = True
        elif prog == "xargs" and rest:
            # Drop xargs' own leading options, keep the command and ITS flags,
            # then append what the pipeline will feed it as operands. An option
            # that takes a SEPARATE value must consume it, else `-I {} rm -rf {}`
            # left `{}` as the command and classified nothing.
            # The replace-string (`-I R`, `-iR`, `--replace=R`; `-i` and
            # `--replace` alone mean `{}`), which xargs substitutes ANYWHERE in
            # an argument — inside `sh -c 'rm -rf {}'` too (XERK-1600).
            cut, replstr = _xargs_options(rest)
            inner = list(rest[cut:])
            if inner:
                # `{}` stands for whatever the pipeline feeds in. Every xargs
                # carries EVERY operand on the line, so n segments emit n²
                # words: 4096 took 18s (XERK-1589), so they share the budget.
                expanded: list[str] = []
                for tok in inner:
                    if tok == "{}":
                        _spend(piped_chars)
                    expanded.extend(piped_operands if tok == "{}" else [tok])
                _spend(piped_chars)
                argvs = [_strip_prefixes(expanded + piped_operands)]
                # A replace-string embedded in an argument becomes ONE operand
                # per run, so each operand is a run of its own.
                # ...and so is each operand fed to a shell, whose `$1` is one
                # path per run under `-n1`/`-L1` (XERK-1636), a few of them.
                shell_run = (len(piped_operands) > 1 and argvs[0]
                             and _basename(argvs[0][0]) in _SHELL_PROGS)
                if (replstr and any(replstr in t and t != replstr for t in inner)) or shell_run:
                    for operand in (_per_run_operands(piped_operands) if shell_run and not replstr
                                    else piped_operands):
                        run = ([t.replace(replstr, operand) for t in inner] if replstr
                               else [*inner, operand])
                        _spend(sum(len(t) + 1 for t in run))
                        argvs.append(_strip_prefixes(run))
                for argv in argvs:
                    out.append((argv, seg))
                    # ...and expanded again, so a shell/eval/wrapper it runs is
                    # unwrapped: `xargs sh -c '<cmd>'` (XERK-1539).
                    out.extend(_expand_segments(
                        " ".join(shlex.quote(t) for t in argv), depth + 1, cwds))
        elif prog == "find":
            roots = _find_roots(tokens) or ["."]
            # Relative roots from inside a protected cwd: `cd /; find . -delete`.
            by_cwd = [(cwd, [_under_cwd(r, cwd) for r in roots]) for cwd in cwds]
            by_cwd = [(cwd, joined) for cwd, joined in by_cwd if joined != roots]
            if "-delete" in rest:
                # Equivalent to a recursive delete of everything it walks,
                # with no preserve-root: `find / -delete` empties `/` (XERK-1687).
                out.append((["rm", "-r", "--no-preserve-root", *roots], seg))
                for cwd, joined in by_cwd:
                    out.append((["rm", "-r", "--no-preserve-root", *joined], seg, False, cwd))
            roots += [r for _, joined in by_cwd for r in joined]
            # `{}` is every path find walks, and under `"$x/$y"` with both unset
            # that is all of `/`: an `-exec rm -rf {} +` deletes it child by
            # child, preserve-root or not. So each root is also read with all
            # of its unknown names empty (XERK-1687).
            roots += [r for r in dict.fromkeys(_unset_names_dropped(t, keep_last=False)
                                               for t in roots) if r and r not in roots]
            # Each flag's run ends at the next terminator, found in ONE
            # backward pass: rescanning and re-slicing `rest` per `-exec` was
            # quadratic (XERK-1589).
            ends, end = [0] * len(rest), len(rest)
            for i in range(len(rest) - 1, -1, -1):
                if rest[i] in (";", "+", "\\;"):
                    end = i
                ends[i] = end
            roots_chars = sum(len(r) + 1 for r in roots)
            for flag in ("-exec", "-execdir", "-ok", "-okdir"):
                for i, flag_tok in enumerate(rest):
                    if flag_tok != flag:
                        continue
                    toks = rest[i + 1:ends[i]]
                    run = []
                    for tok in toks:
                        # `{}` stands for each path found — i.e. the roots.
                        if tok == "{}":
                            _spend(roots_chars)
                        run.extend(roots if tok == "{}" else [tok])
                    runs = [run]
                    # GNU find replaces a `{}` INSIDE an argument too —
                    # `-exec sh -c 'rm -rf {}' \;` — with one path per run
                    # (XERK-1600), so each root is a run of its own.
                    # ...and so does a `{}` handed to a shell, whose `$1` (or
                    # `$0`) is one root per run under `\;` (XERK-1636).
                    lead = _strip_prefixes(run)[:1]
                    shell_run = (len(roots) > 1 and "{}" in toks and lead
                                 and _basename(lead[0]) in _SHELL_PROGS)
                    if any("{}" in t and t != "{}" for t in toks) or shell_run:
                        for root in (_per_run_operands(roots) if shell_run
                                     and not any("{}" in t and t != "{}" for t in toks) else roots):
                            runs.append([t.replace("{}", root) for t in toks])
                            _spend(sum(len(t) + 1 for t in runs[-1]))
                    for run in filter(None, runs):
                        # Every run is classified with the whole segment, and
                        # checkers rescan that text per entry: 5000 runs took
                        # 30s (XERK-1589), so each run charges the segment.
                        _spend(len(seg))
                        argv = _strip_prefixes(run)
                        out.append((argv, seg))
                        # `find . -exec sh -c '<cmd>' \;` (XERK-1539).
                        out.extend(_expand_segments(
                            " ".join(shlex.quote(t) for t in argv), depth + 1, cwds))
    # A file the line writes may run by a route the guard cannot name: a
    # copy, a `$PWD`/`$(pwd)` path, `cat f | sh`, `sh -c 'sh < f'`, `xargs`,
    # `find -exec`, `PATH=.`. Each spelling patched left a neighbour, so a
    # line that writes text and runs ANY file it cannot pin to a written path
    # reads every written file it has not read (XERK-1674).
    unnamed = written != {} and bool(_RUNS_UNNAMED_RE.search(raw_commands))
    if written is None and (unnamed or _C_OR_EVAL_RE.search(raw_commands)):
        written = _written_scripts(
            _split_on_operators(command, include_pipe=False, groups=True), heredocs)
    if written and not (unresolved or unnamed) and _C_OR_EVAL_RE.search(raw_commands):
        # A `-c` script or `eval` naming a written file again (`bash -c ./f`,
        # `sh -c "$(cat f)"`): its runs are read a level down, without this
        # line's writes.
        unnamed = any(len(re.findall(r"(?<![\w.-])" + re.escape(posixpath.basename(w))
                                     + r"(?![\w.-])", raw_commands)) > 1 for w in written)
    if written and (unresolved or unnamed):
        for path in written:
            if path not in runs_seen:
                runs_seen[path] = dict(unresolved) if unresolved else {(): None}
    # A sourced file inherits the caller's `set --`/`$@`: each written file
    # read with no arguments also binds them to the line's path-like words.
    line_words = tuple(dict.fromkeys(
        w for w in (t.rstrip(";&|") for t in _tokenize(raw_commands))
        if w and not _PLAIN_WORD_RE.fullmatch(w) and posixpath.normpath(w) not in written)
        )[:_MAX_LINE_WORDS] if sources and runs_seen and written else ()
    for path, runs in runs_seen.items():
        for script in _script_file_readings(path, list(runs), written or {}, line_words):
            out.extend(_expand_segments(script, depth + 1, every_cd))
    # An unwrap can leave nothing behind (`$(x | xargs kill)`); every checker
    # reads tokens[0], and a crash there let the WHOLE command through (XERK-1080).
    return [entry for entry in out if entry[0]]


# --- dangerous-path detection (for rm / chmod / chown) -------------------

# `cd`/`pushd` (bare or behind `builtin`/`command`) and the words after it.
_CD_RE = re.compile(r"(?:^|[\s;&|({`])(?:(?:builtin|command)\s+)?\\?([\"']?)(?:cd|pushd)\1"
                    r"(?=$|[\s;&|)`])"
                    r"([^;&|\n)`]*)")
_MAX_CWDS = 8
_HOME_USER_RE = re.compile(r"^~[a-z0-9_][a-z0-9_.-]*$")
# A construct that can run earlier text again after a later `cd`. Matched
# loosely — in quotes, comments and heredocs too — since a miss fails open.
_REPLAYS_RE = re.compile(
    r"\b(?:while|until|for|select|function|alias|trap|eval|coproc|BASH_EXECUTION_STRING)\b"
    r"|\(\s*\)")



def _cd_readings(text: str, inherited: tuple[str, ...],
                 line_vals: dict[str, list[str]] | None = None) -> tuple[str, ...]:
    """`_cd_targets` of ``text`` with its substitutions read both as several
    statements and as before XERK-1609 (see `_body_printed`): `cd "$(echo / |
    grep /)"` names `/` only in the second."""
    found = _cd_targets(_sub_substs(text, _subst_text), inherited, line_vals)
    base = _cd_targets(_sub_substs(text, lambda m: _subst_text(m, multi=False)), inherited,
                       line_vals)
    return found + tuple(c for c in base if c not in found)


def _cd_targets(text: str, inherited: tuple[str, ...],
                line_vals: dict[str, list[str]] | None = None) -> tuple[str, ...]:
    """``inherited`` plus each absolute or home directory a `cd` in ``text``
    names; ``line_vals`` adds what the whole line assigns when ``text`` is one
    segment of it. A relative or unknowable one (`cd -`, `cd $OLDPWD`) adds nothing:
    the directories already listed stay listed whatever it does."""
    if "cd" not in text and "pushd" not in text:
        return inherited
    found = list(inherited)
    for m in _CD_RE.finditer(text):
        try:
            args = shlex.split(m.group(2))
        except ValueError:
            args = m.group(2).split()
        ops = [a for a in args if not (a.startswith("-") and len(a) > 1)]
        # A bare `cd` goes home; `cd ~/..` leaves it (XERK-1656).
        targets = ([_norm_path(h) for h in _home_readings(ops[0])] or [_norm_path(ops[0])]
                   if ops else ["~"])
        # `cd -` goes to $OLDPWD, and a relative name is looked up in each
        # $CDPATH entry first: `CDPATH=/; cd etc` is `/etc` (XERK-1662). Only
        # values the line itself assigns; an inherited one stays unknown.
        if ops and (ops[0] == "~-" or not ops[0].startswith(("/", "~"))
                    or ops[0].startswith("~-/")):
            vals = {**(line_vals or {})}
            for name, vs in _var_values(text).items():
                vals[name] = vals.get(name, []) + vs
            # `~-` is `$OLDPWD` too, wherever `cd` is given it.
            if ops[0] in ("-", "~-") or ops[0].startswith("~-/"):
                targets += [v + ops[0][2:] for v in vals.get("OLDPWD", [])]
            elif not ops[0].startswith("."):
                targets += [entry.rstrip("/") + "/" + ops[0]
                            for cdpath in vals.get("CDPATH", ()) for entry in cdpath.split(":")
                            if entry.startswith("/")]
        for target in targets:
            target = _norm_path(target)
            low = target.lower()
            if (low.startswith("/") or low.rstrip("/") in _HOME_TOKENS
                    or _HOME_USER_RE.match(low)):
                target = target.rstrip("/") or "/"
                if target not in found:
                    found.append(target)
        if len(found) >= _MAX_CWDS:
            break
    return tuple(found)


def _is_exact_root(path: str) -> bool:
    low = path.lower()
    return low in _HOME_TOKENS or low in _SYSTEM_ROOTS or bool(_HOME_USER_RE.match(low))


# `$OLDPWD` too: whichever directory the line was in before its last `cd`,
# so any of them (XERK-1696). An inherited one reads as the session's cwd.
# ...and a `${PWD:?}`/`${PWD?}` op, which keeps the set value, and a directory tilde
# (`~-`, `~+`, `~1`) reaching a target unspliced, as through `eval rm '~-'`.
# Whatever is glued on after it (`$x`, `$1`, `${x#a}`, `*`, `.bak`) is joined to the
# directory as bash joins it and judged there: `cd /; rm -rf $PWD*` is `/*`. A tilde
# takes only a `/` or a name (`eval rm -rf '~-'$x`): `~-.bak` is a literal word.
_PWD_LEAD_RE = re.compile(r"(?:\$(?:OLD)?PWD(?!\w)|\$\{(?:OLD)?PWD(?::?\?[^${}]*)?\}"
                          r"|~(?:[+-]|[+-]?[0-9]+)(?=[/$]|$))")


def _under_cwd(tok: str, cwd: str) -> str:
    """An `rm` operand read from inside ``cwd``. Inside an exact protected root
    every relative operand is joined (`cd /etc; rm -rf ./*` is `/etc/*`).
    Deeper, only one climbing out with `..` is (`cd /tmp; rm -rf ../*` is
    `/*`): joining the rest would refuse `cd /usr/src/app && rm -rf build`,
    which names nothing an absolute rm would not, for a cwd that may be stale.
    One that lands on the session home or a directory holding it is joined too:
    `cd ~/.. && rm -rf x` is the home itself (XERK-1752)."""
    if m := _PWD_LEAD_RE.match(tok):
        # `$PWD` is the directory `cd` left, read as a relative operand is:
        # `cd /; rm -rf $PWD/etc` (XERK-1685).
        rest = tok[m.end():]
        if rest[:1] not in ("", "/"):
            joined = (cwd.rstrip("/") or "/") + rest
            if _is_exact_root(cwd) or ".." in rest.split("/") or _holds_home(joined, cwd):
                return joined
            return tok
        rest = rest.lstrip("/")
        joined = (cwd.rstrip("/") + "/" + rest).rstrip("/") or "/"
        if _is_exact_root(cwd) or ".." in rest.split("/") or _holds_home(joined, cwd):
            return joined
        return tok
    if tok.startswith(("-", "/", "~", "$", _OPAQUE_SUBST)):
        return tok
    joined = cwd.rstrip("/") + "/" + tok
    if _is_exact_root(cwd) or ".." in tok.split("/") or _holds_home(joined, cwd):
        return joined
    return tok


def _holds_home(path: str, cwd: str) -> bool:
    """Whether ``path`` (absolute, maybe a glob) may name the session home, a
    directory above it, or (from a ``cwd`` above it) a glob over its contents,
    matched component by component: after `cd ~/..`, `x`, `./x/`, `x/*` and `*`
    all reach the home (XERK-1752). An unset name reads empty (`x$n` is `x`).
    A cwd that is not absolute (an unresolved `$d`) holds nothing we can place."""
    home = _session_home()
    if not home or not path.startswith("/"):
        return False
    want = [c for c in posixpath.normpath(home).split("/") if c]
    above = len([c for c in posixpath.normpath(cwd).split("/") if c]) < len(want)
    for text in {path, _EXPANSIONS_RE.sub("", path)}:
        have = [c for c in posixpath.normpath(text).split("/") if c]
        # Past the home only a glob joins (`x/*` is its contents), and only from
        # above it: a join is judged as an absolute path, so a named child under
        # a protected root (/var/…/home/x/build), or `cd ~ && rm -rf .c*`
        # (`/home/x/.c*`), would refuse an ordinary cleanup.
        past = have[len(want):]
        if all(g == h or fnmatch.fnmatchcase(h, g) for g, h in zip(have, want)) and (
                not past or (above and all(re.search(r"[*?\[]", g) for g in past))):
            return True
    return False


# Absolute roots whose recursive removal/permission-change destroys the host.
_SYSTEM_ROOTS = (
    "/",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/opt",
    "/proc",
    "/root",
    "/sbin",
    "/srv",
    "/sys",
    "/usr",
    "/var",
    "/system",
    "/library",
    "/applications",
    "/users",
)
_HOME_TOKENS = {"~", "~/", "$home", "${home}", "%userprofile%", "%homepath%", "%homedrive%"}


_GLOB_CHARS = re.compile(r"[*?\[]")


def _norm_path(tok: str) -> str:
    t = tok.strip().strip('"').strip("'")
    # `//etc` and `/etc//` address exactly what `/etc` does; the shell collapses
    # repeated separators and so must this, or `rm -rf //etc` reads as unmatched.
    # Done before normpath, which POSIX requires to PRESERVE exactly two.
    t = re.sub(r"/{2,}", "/", t)
    # `/./etc` and `/tmp/../etc` also name /etc. Only for real paths — normpath
    # on a bare word would turn "" into "." and lose the empty-token case.
    if "/" in t and not t.startswith("~"):
        t = posixpath.normpath(t) + ("/" if t.endswith("/") and t != "/" else "")
    # Windows drive root (C:\ , C:/ , c:) and Windows system dirs.
    return t


def _shell_fnmatch(name: str, pattern: str) -> bool:
    """fnmatch read as bash globs (XERK-1654).

    Python's fnmatch reads `[^x]` as a literal `^` and has no `[[:alpha:]]`
    class, so `/e[[:alpha:]]c` and `/[^x]tc` never matched `/etc`. Negate as
    bash does. With a class, equivalence class or collating symbol anywhere,
    the text from the first `[` to the last `]` becomes `*`: whatever brackets
    bash finds in it, the string it matches there is one `*` matches too, so
    the match can only widen (fail closed) and no bracket is parsed at all —
    a parse started inside an outer bracket, or one that backtracks, is how
    such a rewrite reopens a hole.
    """
    if re.search(r"\[[:=.]", pattern):
        start, end = pattern.find("["), pattern.rfind("]")
        pattern = pattern[:start] + "*" + pattern[end + 1:]
    return fnmatch.fnmatch(name, pattern.replace("[^", "[!"))


def _glob_names_home(word: str) -> bool:
    """A home token straight followed by a glob that may match the home itself
    (`$HOME*`, `${HOME}?`), as literal `/root*` may match /root (XERK-1654).
    A `~` is left out: bash expands no tilde in `~*`, which globs the cwd.
    A glob that may match `/root` itself counts too (`/root*/.ssh`)."""
    if word.startswith("/") and _GLOB_CHARS.search(word) and _shell_fnmatch("/root", word):
        return True
    for home in _HOME_TOKENS:
        rest = word[len(home):]
        if (not home.startswith("~") and word.startswith(home) and _GLOB_CHARS.search(rest)
                and (_shell_fnmatch("", rest) or _shell_fnmatch("/", rest))):
            return True
    return False


def _glob_hits_system_root(pattern: str) -> bool:
    """True if an absolute glob could expand onto a system root.

    `rm -rf /et*` deletes `/etc` — the shell expands it before `rm` ever runs,
    so a literal-only comparison never saw the target. Only ABSOLUTE patterns
    are judged this way: a bare `*` cannot name `/etc`, and treating it as if it
    could would refuse an ordinary `rm -rf *` in a build directory.
    """
    if not pattern.startswith("/"):
        return False
    for root in _SYSTEM_ROOTS:
        bare = root.rstrip("/") or "/"
        if _shell_fnmatch(bare, pattern) or _shell_fnmatch(bare + "/", pattern):
            return True
    return False


# What may follow the names a word ends with: separators and `.`, which make
# the path it names no deeper, or any text holding a glob character, which
# may match a root itself (`/e$x*c` is `/etc`) and is judged as a glob.
_TRAILING_PATH_TAIL_RE = re.compile(r"[/.]*|.*[*?\[].*", re.DOTALL)


def _trailing_unset_dropped(tok: str, after_slash: bool = True) -> str | None:
    """``tok`` with the unset names ENDING it read as empty, else None
    (XERK-1623).

    `rm -rf /etc$x` deletes /etc when x is unset, `$HOME$x` the home
    directory, and `find /etc$x/. -delete` or `rm -rf /e$x*` the same root.
    A name counts as ending the word when only `/` and `.` follow it, or
    text holding a glob character (`/e$x*c`), and only with text before it: a whole-word `"$d"` is left
    alone, since an empty target reads as the root, as is a name before more
    text (`"$dir"/build`, `./"$name".git`), which is a path built from it.
    A name inside a tilde prefix (`~$USER`) is kept: bash does not expand
    that tilde, so the word never names a home. A `${x:-w}` default is
    spliced before this sees the word.
    """
    if "$" not in tok:
        return None
    tilde_end = (tok.find("/") % (len(tok) + 1)) if tok.startswith("~") else 0
    spans = []
    tail = len(tok)
    for start, end, _kind in reversed(_param_spans(tok)):
        if start <= tilde_end or not _TRAILING_PATH_TAIL_RE.fullmatch(tok, end, tail):
            break
        spans.insert(0, (start, end))
        tail = start
    # `after_slash=False` keeps a run that is a whole last component
    # (`"$TMP/$x"`), for a reading that already dropped the leading names.
    if not spans or (not after_slash and tok[spans[0][0] - 1] == "/"):
        return None
    pieces, last = [], 0
    for start, end in spans:
        pieces.append(tok[last:start])
        last = end
    pieces.append(tok[last:])
    return "".join(pieces)


def _is_dangerous_path(tok: str, trailing: bool = True) -> bool:
    if tok.startswith(_UNREAD_OUTPUT + " "):
        # An assigned op's several readings, stored joined (`y=${q%x$nope}`),
        # reach a quoted `"$y"` as ONE word: each reading is a target of its
        # own (XERK-1673). Split here, never where `$y` is spliced: there a
        # `bash -c "$y …"` script was cut into script and arguments (QA).
        return any(_is_dangerous_path(w, trailing) for w in tok.split(" ")[1:] if w)
    dropped = _trailing_unset_dropped(tok) if trailing else None
    if dropped is not None and _is_dangerous_path(dropped):
        return True
    raw = _norm_path(tok)
    low = raw.lower().rstrip("/").rstrip("\\")
    bare = raw.lower()
    if not raw.strip():
        # Nothing is named at all. This must NOT read as the filesystem root:
        # an unknown substitution used to collapse to "" and take this branch.
        return False
    # `rm -rf /$(cat x)` IS `rm -rf /` when the substitution prints nothing, and
    # `/` plus an unknown has no safe reading. The placeholder is harmless as a
    # WHOLE token; appended to a root it must not launder it.
    if _OPAQUE_SUBST in low:
        # What PRECEDES the placeholder is the whole question. Nothing before it
        # means the substitution is the entire target (`rm -rf "$(mktemp -d)"`),
        # which is unknowable but not a root. A root before it is the dangerous
        # case — hence the empty-prefix test happens BEFORE any rstrip, which
        # would flatten `/` and `` to the same thing.
        prefix = low.split(_OPAQUE_SUBST)[0]
        stem = prefix.rstrip("/")
        if prefix and (stem == "" or stem == "~" or stem in _HOME_TOKENS
                       or stem in _SYSTEM_ROOTS
                       # `~root/` + empty output is `/root/` — the same case as
                       # `~/`, which the bare-`~` test already covers.
                       or re.match(r"^~[a-z0-9_][a-z0-9_.-]*$", stem)):
            return True
    if bare in _HOME_TOKENS or low in _HOME_TOKENS:
        return True
    # A glob straight under a home directory that can match its dotfiles
    # (`~/*`, `~/.*`, `~/.[!.]*`) takes `.ssh` and the rest with it.
    parent, _, leaf = low.rpartition("/")
    if (_GLOB_CHARS.search(leaf) and (parent in _HOME_TOKENS or _HOME_USER_RE.match(parent)
                                      or _glob_names_home(parent))
            and _shell_fnmatch(".ssh", leaf)):
        return True
    if _glob_names_home(low):
        return True
    # `~root` / `~someuser` expand to that account's home, and `/root` is itself
    # a system root.
    if re.match(r"^~[a-z0-9_][a-z0-9_.-]*/?$", low):
        return True
    if raw in ("/", "/*") or low == "":
        # "" results from rstrip of "/" — i.e. the filesystem root.
        return True
    # `.git` (with or without trailing slash / leading ./) → repo history.
    if low.endswith("/.git") or low in (".git", "./.git") or low.endswith("\\.git"):
        return True
    if _GLOB_CHARS.search(low) and _glob_hits_system_root(low):
        return True
    # Windows drive roots: C:, C:\, C:\windows, C:\users, ...
    if re.match(r"^[a-z]:([\\/].*)?$", low):
        seg = low.split(":", 1)[1].strip("\\/")
        if seg in ("", "windows", "users", "program files", "program files (x86)", "system32"):
            return True
    # POSIX system roots: exact match or a direct child of the root.
    for root in _SYSTEM_ROOTS:
        if low == root or low.startswith(root.rstrip("/") + "/"):
            # Allow obviously-scoped temp/build paths under a root only when
            # they are deep, well-known throwaway dirs.
            if root == "/" and low not in ("/", "/*"):
                # e.g. "/tmp/build" — a child of root but not a system dir.
                # Fall through to the specific-root checks below.
                continue
            return True
    return False


def _is_home_ssh(tok: str, home_read: bool = True) -> bool:
    """`~/.ssh` itself — deleting it loses the keys, though `chmod -R 700` of
    it is the routine permission fix, so only `rm` asks this."""
    dropped = _trailing_unset_dropped(tok)
    if dropped is not None and _is_home_ssh(dropped):
        return True
    if home_read and any(_is_home_ssh(h, home_read=False)
                         for h in _home_readings(tok.strip().strip('"').strip("'"))):
        return True
    parent, _, leaf = _norm_path(tok).lower().rstrip("/").rpartition("/")
    return leaf == ".ssh" and (parent in _HOME_TOKENS or bool(_HOME_USER_RE.match(parent))
                               or _glob_names_home(parent))


# A target that STARTS with names: by here every name this line assigns or
# defaults is substituted, so these are unknown, and bash reads an unset one as
# empty — `rm -rf "$x"/etc` deletes /etc (XERK-1639). Only a name directly
# before a `/` counts, so `"$x"*` and `"$x".bak` stay relative. A `${…}` with an
# operator is empty too (`"${dir%/}"/*`, `${x:+$x}/etc`), unless it is a length
# or supplies a non-empty default or error (`${x:-a}`, `${x:?}`).
_PLAIN_NAME_RE = re.compile(r"\$([A-Za-z_]\w*)")
# The name opening a `${…}` body: `x`, `!x`, `x[0]`. A `#` (length) never matches.
_BRACED_NAME_RE = re.compile(r"!?([A-Za-z_]\w*)(?:\[[^\]{}]*\])?")
_EXPANSIONS_RE = re.compile(r"\$\{[^{}]*\}|\$[A-Za-z_]\w*")
# Set in every shell an agent runs, so never read empty: `$HOME/.cache` is not `/.cache`.
# Positionals (`$1`, `$@`) are left out on purpose: inside `bash -c '…' _ /tmp/x`,
# `find -exec sh -c` or a function they are bound, which this check cannot see.
_ALWAYS_SET_NAMES = {"HOME", "PWD"}
_ALWAYS_SET_RE = re.compile(r"\$(?:HOME|PWD)(?!\w)|\$\{(?:HOME|PWD)\}")


def _only_expansions(word: str) -> bool:
    """True if ``word`` is nothing but quotes, blanks and names, so it can be
    empty too: the default in `${x:-${y}}` or `${x:-"$y"}`."""
    # A bare always-set name is text; under an operator (`${HOME:+}`,
    # `${y:+$HOME}`) it can still be empty, so it is only kept as a letter.
    word = _ALWAYS_SET_RE.sub("H", word.replace('"', "").replace("'", ""))
    for _ in range(16):  # one pass per nesting level; deeper reads as empty
        word, n = _EXPANSIONS_RE.subn("", word)
        if not n:
            return not word.strip()
    return True


def _empties_a_set_path(op: str) -> bool:
    """Whether `${HOME<op>}` can be empty though HOME holds a path. Only the
    operators that cannot are listed: a default or `?` (unused, HOME is set),
    a case change or `@` transform, and stripping one `/`. Any other pattern
    can match the whole path, a literal one too (`${HOME#/root}`)."""
    if op[:2] == ":+" or op[:1] == "+":
        return _only_expansions(op[2 if op[0] == ":" else 1:])
    return not (op == "" or op[:1] in ("-", "=", "?", "^", ",", "@")
                or op[:2] in (":-", ":=", ":?") or op in ("%/", "#/"))


def _name_end(raw: str, pos: int) -> tuple[int, bool]:
    """The end of the expansion at ``pos`` and whether it can be empty, or
    ``(pos, False)`` if none starts there. A `${…}` is closed by `_brace_end`,
    so a nested one (`${x:+${y}}`) is one expansion; an unclosed one is none."""
    if m := _PLAIN_NAME_RE.match(raw, pos):
        name, op, end = m.group(1), "", m.end()
    elif raw.startswith("${", pos):
        # Unquoted: the token is dequoted, and looking its quotes up rescans
        # the whole word per `${`, quadratic in a run of names (QA).
        close = _brace_end(raw, pos, False)
        if close < 0:
            return pos, False
        head = _BRACED_NAME_RE.match(raw, pos + 2, close)
        if head is None:
            return close + 1, False
        name, op, end = head.group(1), raw[head.end():close], close + 1
        if head.group(0) != name:
            name = ""  # `${HOME[1]}` and `${!HOME}` are not HOME's value
    else:
        return pos, False
    # `?` errors and a default or assigned word is used; only an empty one
    # leaves it empty. HOME and PWD are set, so only another operator
    # (`${HOME:+}`, `${HOME#$HOME}`) can empty them.
    body = op[1:] if op.startswith(":") else op
    if body[:1] == "?" or (body[:1] in ("-", "=") and not _only_expansions(body[1:])):
        return end, False
    if name in _ALWAYS_SET_NAMES and not _empties_a_set_path(op):
        return end, False
    return end, True


def _unset_names_dropped(raw: str, keep_last: bool = True) -> str | None:
    """``raw`` with the unknown names bash would read as empty dropped, or
    None if it has none (XERK-1639, XERK-1652). Every such name in a component
    before the last is dropped: `/$x/etc` and `"$x/usr$y/lib"` are `/etc` and
    `/usr/lib`, `"$a/$b"/*` is `//*`. In the last component only a trailing run
    glued to text is (`$x/etc$y` is `/etc`): `"$dir/$f"`, `"$TMP/$x"` and
    `"$dir/$name.$ext"` are the everyday idiom, `/` or `/.` only when all are
    unset. A word that is one component counts as two when names alone
    open it before a `/`: `$x/` is the root, `"$x"*` and `"$x".bak` stay.
    Without ``keep_last`` every name is dropped, the last component's too:
    `"$x/$y"` is `/` (XERK-1687)."""
    # (start, end) of each name that can be empty, and every `/` between them.
    names, slashes, pos = [], [], 0
    while pos < len(raw):
        nxt = min((i for i in (raw.find("$", pos), raw.find("/", pos)) if i >= 0), default=-1)
        if nxt < 0:
            break
        if raw[nxt] == "/":
            slashes.append(nxt)
            pos = nxt + 1
            continue
        end, empty = _name_end(raw, nxt)
        if empty:
            names.append((nxt, end))
        pos = max(end, nxt + 1)
    # The last component starts after the last `/` with more than `/`s after it.
    last = len(raw.rstrip("/"))
    seps = [i for i in slashes if i < last]
    if not keep_last:
        cut = len(raw)
    elif seps:
        cut = seps[-1]
    elif slashes and names and names[0][0] == 0:
        # One component before trailing `/`s: names alone must fill it.
        cut = slashes[0]
        filled = 0
        for start, end in names:
            if start != filled:
                break
            filled = end
        if filled != cut:
            cut = 0
    else:
        cut = 0
    # A `~` prefix is not expanded once a name is in it (`~$USER`): keep them.
    tilde = (raw.find("/") % (len(raw) + 1)) if raw.startswith("~") else -1
    pieces, kept = [], 0
    for start, end in names:
        if end <= cut and start > tilde:
            pieces.append(raw[kept:start])
            kept = end
    pieces.append(raw[kept:])
    rest = "".join(pieces)
    dropped = _trailing_unset_dropped(rest, after_slash=False)
    if dropped is not None:
        return dropped
    return rest if kept else None


# The session's own HOME, which bash expands `~` and `$HOME` to (XERK-1656).
# Built from it, a target can leave the home: `$HOME/..` is the home's parent,
# `${HOME/root/etc}` is /etc, `${HOME:+/etc}` is /etc. As a token, `$HOME/..`
# normpaths to `.` and an operator hides the name, so each was allowed.
_HOME_NAME_RE = re.compile(r"\$HOME(?!\w)")

# The `${HOME@x}` transforms that leave a path: `@E`/`@P` expand escapes and
# prompt codes, which a path holding none keeps as it is.
_HOME_TRANSFORMS = {"@E": lambda v: v, "@P": lambda v: v, "@L": str.lower,
                    "@U": str.upper, "@u": lambda v: v[:1].upper() + v[1:]}
# Past this many `${HOME<op>}` in one target the reading is `/`: each pattern
# operator costs a match per substring of HOME, and a target that size is no path.
_MAX_HOME_OPS = 64


def _session_home() -> str | None:
    """HOME as bash holds it: an op sees its text, so it is not normalised
    (`${HOME%root/}etc` is /etc when HOME=/root/)."""
    home = os.environ.get("HOME", "")
    if not home.startswith("/"):
        try:
            import pwd
            home = pwd.getpwuid(os.getuid()).pw_dir
        except (ImportError, KeyError, AttributeError):
            return None
    return home if home.startswith("/") and len(home) <= 256 else None


# Which reading of an extglob op on HOME `_home_expanded` takes, and the most
# readings one had (`_home_readings` tries each, XERK-1664).
_HOME_EXT_PICK = [0]
_HOME_EXT_N = [1]


def _home_ext_pick(readings: list[str]) -> str:
    """The `_HOME_EXT_PICK`th of an op's readings (extglob off, then on)."""
    _HOME_EXT_N[0] = max(_HOME_EXT_N[0], len(readings))
    return readings[min(_HOME_EXT_PICK[0], len(readings) - 1)]


def _home_expanded(raw: str, home: str, budget: list[int]) -> str | None:
    """``raw`` with `~`, `$HOME` and `${HOME<op>}` expanded against ``home``
    by the guard's own op evaluation, or None when an operator on HOME is one
    it cannot read. Other names stay as written, except in an operator's word,
    where an unset one reads empty as in bash (`${HOME/root/$y}` is `/`)."""

    def word(text: str) -> str | None:
        text = _home_expanded(text, home, budget)
        if text is None:
            return None
        for _ in range(16):
            text, n = _EXPANSIONS_RE.subn("", text)
            if not n:
                return text
        return None

    out, pos = [], 0
    if raw == "~" or raw.startswith("~/"):
        out.append(home)
        pos = 1
    while (dollar := raw.find("$", pos)) >= 0:
        out.append(raw[pos:dollar])
        if m := _HOME_NAME_RE.match(raw, dollar):
            out.append(home)
            pos = m.end()
            continue
        close = _brace_end(raw, dollar, False) if raw.startswith("${HOME", dollar) else -1
        if close < 0:
            out.append("$")
            pos = dollar + 1
            continue
        tail = raw[dollar + 6:close]
        if tail[:1] == "[":
            return None  # an element: not evaluated
        if tail[:1].isalnum() or tail[:1] == "_":
            out.append("$")  # another name (`${HOMEDIR}`)
            pos = dollar + 1
            continue
        budget[0] -= 1
        if budget[0] < 0:
            return "/"  # a target this size is no path; read it as the root
        op = _VAR_OP_RE.match(tail)
        if tail == "" or tail[:1] in ("-", "=", "?") or tail[:2] in (":-", ":=", ":?"):
            value = home  # set and non-empty, so the default is unused
        elif tail in _CASE_OPS:
            value = _CASE_OPS[tail](home)
        elif tail in _HOME_TRANSFORMS:
            value = _HOME_TRANSFORMS[tail](home)
        elif op is None:
            return None  # a quoting transform (`${HOME@Q}`): no path
        elif op.group(1) in ("/", "//"):
            pat, rep = _split_replace(op.group(2))
            pat, rep = word(pat), word(rep)
            if pat is None or rep is None:
                return None
            value = _home_ext_pick(_var_op_readings(home, op.group(1), pat, rep))
        else:
            arg = word(op.group(2))
            if arg is None:
                return None
            value = _home_ext_pick(_var_op_readings(home, op.group(1), arg))
        out.append(value)
        pos = close + 1
    out.append(raw[pos:])
    return "".join(out)


def _user_home(name: str) -> str | None:
    """`~name`'s directory as bash finds it, or None when it has none here."""
    try:
        import pwd
        home = pwd.getpwnam(name).pw_dir
    except (ImportError, KeyError):
        return None
    home = posixpath.normpath(re.sub(r"/{2,}", "/", home))
    return home if home.startswith("/") else None


def _home_readings(raw: str) -> list[str]:
    """`_home_one_reading` once per reading of an extglob op on HOME
    (extglob off first, XERK-1664); empty when there is none. Every caller
    judges them ALL: one picked by a single judge dropped what another
    sees, and read as `/` a glued `/.ssh` was lost."""
    _HOME_EXT_PICK[0], _HOME_EXT_N[0] = 0, 1
    out = []
    try:
        pick = 0
        while pick < _HOME_EXT_N[0]:
            _HOME_EXT_PICK[0] = pick
            got = _home_one_reading(raw)
            if got is not None and got not in out:
                out.append(got)
            pick += 1
    finally:
        _HOME_EXT_PICK[0], _HOME_EXT_N[0] = 0, 1
    return out


def _home_one_reading(raw: str) -> str | None:
    """``raw`` read with the session's HOME expanded (and a `~user` prefix,
    as bash does), or None when it names no home or the reading cannot be
    made. A reading that stays inside a home is put back as `$HOME…`/`~user…`,
    which the home rules judge (`$HOME/.cache` is not `/root/.cache`, a child
    of the /root system root); one that leaves it is an absolute path with its
    `..` folded (`$HOME/..` is `/` when HOME=/root)."""
    tilde = re.match(r"~([a-z0-9_][a-z0-9_.-]*)(?=/|$)", raw)
    if not raw.startswith("~") and "$HOME" not in raw and "${HOME" not in raw:
        return None
    home = _session_home()
    if home is None:
        return None
    # Only a home that holds a person's files maps back. With HOME=/ every
    # path is "inside" it, and a system account's home is a system directory
    # (`~bin/x` is /bin/x, `~daemon/sshd` /usr/sbin/sshd).
    norm = posixpath.normpath(re.sub(r"/{2,}", "/", home))
    homes = [("$HOME", norm)] if norm != "/" else []
    if tilde:
        user = _user_home(tilde.group(1))
        if user is None:
            return None  # bash leaves an unknown `~name` as text
        if user == norm or user.startswith(("/home/", "/Users/")) or user == "/root":
            homes.insert(0, (tilde.group(0), user))
        raw = user + raw[tilde.end():]
    path = _home_expanded(raw, home, [_MAX_HOME_OPS])
    if path is None or path == raw and not tilde:
        return None
    path = re.sub(r"/{2,}", "/", path)
    slash = "/" if path.endswith("/") and path != "/" else ""
    if path.startswith("/"):
        path = posixpath.normpath(path)
    for prefix, root in homes:
        # A glob straight after the home stays one too: `$HOME*/build`.
        if path.startswith(root) and path[len(root):len(root) + 1] in ("", "/", "*", "?", "["):
            return prefix + path[len(root):] + slash
    return path + slash


def _dangerous_target(tok: str, home_read: bool = True, keep_last: bool = True) -> str | None:
    """Why ``tok`` names a protected path, or None. Besides the target as
    written, it is read with its unknown names empty (`_unset_names_dropped`),
    and that reading is judged by `_is_dangerous_path` like any other:
    `"$build"/out` reads `/out`, an ordinary root child, and stays allowed
    (owner decision on XERK-1639). The names are found before `_norm_path`,
    whose normpath folds `$x/../etc` into `etc` and `./$x/etc` into `$x/etc`.
    ``keep_last`` keeps the names of the last component (`"$dir/$f"`), which
    only GNU rm's preserve-root makes safe when they read `/` (XERK-1687)."""
    if tok.startswith(_UNREAD_OUTPUT + " "):
        # Several readings kept one word (`_READINGS_JOINED`): each is a target.
        return next(filter(None, (_dangerous_target(w, home_read, keep_last)
                                  for w in tok.split(" ")[1:] if w)), None)
    if _is_dangerous_path(tok):
        return f"({tok!r})"
    raw = tok.strip().strip('"').strip("'")
    empty = _unset_names_dropped(raw, keep_last)
    # Judged as is: XERK-1623's trailing reading on top would read `"$TMP/$x"`
    # as `/`; `_unset_names_dropped` already drops the trailing names it may.
    if empty is not None and _is_dangerous_path(empty, trailing=False):
        return f"({tok!r}, which is {_norm_path(empty)!r} when its unknown names are unset)"
    for home in _home_readings(raw) if home_read else ():
        if _dangerous_target(home, home_read=False, keep_last=keep_last):
            return f"({tok!r}, which is {home!r} with the home expanded)"
    return None


def _rm_is_recursive(flags: str) -> bool:
    """`-r` alone already deletes a tree.

    This used to require `-f` as well. `-f` only suppresses prompts, and Claude
    Code runs Bash non-interactively where there is no prompt to answer, so
    `rm -r /etc` deleted just as silently as `rm -rf /etc` while being allowed.
    """
    return "r" in flags


def _destructive_rm(tokens: list[str]) -> str | None:
    prog = _basename(tokens[0])
    if prog not in ("rm", "unlink"):
        # Windows recursive deletes handled separately.
        return None
    flags = ""
    targets: list[str] = []
    for tok in tokens[1:]:
        if tok.startswith("--"):
            if tok in ("--recursive", "--force"):
                flags += tok[2]  # 'r' or 'f'
            continue
        if tok.startswith("-") and len(tok) > 1:
            flags += tok[1:].lower()
            continue
        targets.append(tok)
    if prog == "rm" and not _rm_is_recursive(flags):
        return None
    # GNU rm refuses `/`, so a last component of names reading `/` is left
    # alone (`"$dir/$f"`); without that refusal it is read empty (XERK-1687).
    preserve_root = "--no-preserve-root" not in tokens
    for tgt in targets:
        if _is_home_ssh(tgt):
            return f"refusing recursive delete of a protected path ({tgt!r})"
        why = _dangerous_target(tgt, keep_last=preserve_root)
        if why:
            return f"refusing recursive delete of a protected path {why}"
    return None


def _destructive_powershell_remove(segment: str) -> str | None:
    low = segment.lower()
    if "remove-item" not in low and not re.search(r"\b(rd|rmdir)\b", low):
        return None
    if (
        "-recurse" not in low
        and not re.search(r"\bremove-item\b.*\*", low)
        and not re.search(r"\b(rd|rmdir)\b\s+/s", low)
    ):
        return None
    for tok in _tokenize(segment):
        if _is_dangerous_path(tok):
            return f"refusing recursive delete of a protected path ({tok!r})"
    # Bare drive/home targets without quotes.
    if re.search(r"(c:\\?|%userprofile%|\$home|~)\s*($|['\"])", low):
        return "refusing recursive delete of a protected path"
    return None


# --- disk / power / fork-bomb -------------------------------------------

_DISK_PROGS = {
    "mkfs",
    "mke2fs",
    "fdisk",
    "parted",
    "wipefs",
    "blkdiscard",
    "shred",
    "diskpart",
    "format",
}
_POWER_PROGS = {"shutdown", "reboot", "halt", "poweroff"}

# The agent's OWN service units. Stopping or restarting one kills the manager
# that supervises every session on this host — including the session issuing the
# command — so it belongs with the power-state rules rather than with ordinary
# service management. A session has no way to bring it back afterwards, and
# systemd will not: five rapid restarts trip StartLimitBurst and leave the unit
# stopped with no retry, which is how the truenas host lost its agent for 7.5
# hours. Ask the operator instead.
_AGENT_UNITS = {
    "turma-agent", "turma-agent.service",
    "turma-agent-update", "turma-agent-update.service", "turma-agent-update.timer",
}

# systemctl verbs that take the unit DOWN (or stop it coming back). Read-only
# verbs — status, show, cat, is-active, list-units — are deliberately absent:
# a session should be able to look at its own agent.
_SERVICE_DOWN_VERBS = {
    "stop", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart",
    "kill", "disable", "mask",
}


def _destructive_agent_service(tokens: list[str]) -> str | None:
    prog = _basename(tokens[0])
    args = [t for t in tokens[1:] if not t.startswith("-")]
    if prog == "systemctl":
        if args and args[0] in _SERVICE_DOWN_VERBS and any(
            a.lower() in _AGENT_UNITS for a in args[1:]
        ):
            return (
                "refusing to stop/restart the Turma agent's own service — it "
                "supervises every session on this host, including yours, and a "
                "session cannot start it again. Ask the operator."
            )
    # The installed helper wraps the same operations for hosts without systemd.
    if prog == "turma-agentctl" and args and args[0] in ("stop", "restart"):
        return (
            "refusing to stop/restart the Turma agent — it supervises every "
            "session on this host, including yours. Ask the operator."
        )
    # Signalling the manager directly is the same act by another route.
    if prog in ("pkill", "killall") and any(
        "hub-agent" in t or "turma-agent" in t for t in tokens[1:]
    ):
        return (
            "refusing to kill the Turma agent manager — it supervises every "
            "session on this host, including yours. Ask the operator."
        )
    return None
# tmux global options that take a value (`tmux [-2CDlNuVv] [-c cmd] [-f file]
# [-L name] [-S path] [-T features] command ...`). Short flags cluster, so
# `-uL qa` names a server just as `-u -L qa` does.
_TMUX_VALUE_FLAGS = "cfLST"

# The tmux commands that destroy a session, or its only window/pane. tmux takes
# any unique prefix of a command name, hence prefixes rather than full names.
_TMUX_KILL_TARGET = (
    "kill-ses", "kill-win", "kill-pan", "killw", "killp",
    "respawn-p", "respawn-w", "respawnp", "respawnw", "unlink-w", "unlinkw",
)

# The Turma agent's own tmux server (XERK-1078): `TMUX_SOCKET` in hub-agent.py.
# Every session is a pane of it. Sessions of an older agent can still be on the
# DEFAULT server across an in-place upgrade, so both stay protected.
_AGENT_TMUX_SOCKET = "turma"

_TMUX_HOST_REASON = (
    "every Turma session on this host, including yours, runs in the agent's "
    "tmux server (`-L " + _AGENT_TMUX_SOCKET + "`, or the default server for a "
    "session an older agent started). Use a private server for tests: "
    "`tmux -L <name> ...`."
)


def _tmux_server(tokens: list[str]) -> tuple[str | None, int]:
    """The server a tmux call names with -L/-S (None = one Turma sessions may run
    in: the default server or the agent's), and the index of its command word."""
    server = None
    i = 1
    while i < len(tokens) and tokens[i].startswith("-") and len(tokens[i]) > 1:
        tok = tokens[i]
        i += 1
        if tok == "--":
            break
        for k, flag in enumerate(tok[1:], start=1):
            if flag in _TMUX_VALUE_FLAGS:
                value = tok[k + 1:]
                if not value and i < len(tokens):
                    value = tokens[i]
                    i += 1
                if flag == "L":
                    # tmux joins -L onto its socket dir, so `./turma`, `turma/`
                    # or `../tmux-0/turma` name the same socket: normalize, and a
                    # name that still walks directories can't be told apart.
                    server = posixpath.normpath(value) if value else value
                    if "/" in server or "\\" in server or server in (".", ".."):
                        server = "default"
                elif flag == "S":
                    server = re.split(r"[\\/]", value.rstrip("/\\"))[-1]
                break
    # `-L default` / `-S .../default` IS the host's server by another name, the
    # agent's own `-L turma` is where sessions run, and a value the guard cannot
    # see (`-S "${TMUX%%,*}"`) may be either.
    if server is not None and ("$" in server or "`" in server or _OPAQUE_SUBST in server):
        server = None
    return (None if server in ("default", "", _AGENT_TMUX_SOCKET) else server), i


def _tmux_target_is_agent(target: str | None) -> bool:
    """Could this -t target resolve to an `agent-<id>` session?

    tmux resolves a target as an exact name, then a unique PREFIX, then a
    glob, so `ag`, `agent*` and `*` all reach `agent-abcde`. Only `=name` is
    exact. No target, or one the guard cannot see (a variable, a loop value),
    means the current or most recent session — possibly another agent's.
    """
    if not target or "$" in target or target == _OPAQUE_SUBST:
        return True
    # A pane/window id (`%3`, `@2`) or special token (`{last}`, `!`, `~`) can be
    # any session's — `list-panes -a` then a kill by id is ordinary tmux use.
    if target[0] in "%@{!~+-":
        return True
    if target.startswith("="):
        return target[1:].startswith("agent-")
    name = target.split(":")[0].split(".")[0]
    if not name or any(c in name for c in "*?["):
        return True
    return name.startswith("agent-") or "agent-".startswith(name)


def _destructive_agent_tmux(tokens: list[str]) -> str | None:
    """Refuse taking down the tmux server, or a session, other sessions run in.

    Sessions run as panes of ONE tmux server, the agent's `-L turma` (XERK-1078;
    the default server for a session an older agent started), and a session's
    runtime starts with `$TMUX` unset, so its bare `tmux` reaches the default
    server. This net stays as defence in depth (XERK-1077: a QA subagent's
    `tmux kill-server` killed every session on a host, back when sessions were
    on the default server and inherited `$TMUX`). A call naming any other server
    with `-L`/`-S` is left alone.
    """
    prog = _basename(tokens[0])
    # `pkill -f "tmux: server"` is how `ps` names the server, so match the word
    # inside an argument, not just a whole `tmux` token.
    if prog in ("pkill", "killall") and any(
        re.search(r"(^|[^a-z0-9])tmux([^a-z0-9]|$)", re.sub(r"[\[\]^$\\]", "", t.lower()))
        for t in tokens[1:]
    ):
        return "refusing to kill tmux processes — " + _TMUX_HOST_REASON
    if prog != "tmux":
        return None
    server, i = _tmux_server(tokens)
    if server is not None:
        return None
    # An expansion as the server (`-S "${TMUX%%,*}"`) can also split into extra
    # words and shift where the command starts, so scan every word for it.
    if any("$" in t or t == _OPAQUE_SUBST for t in tokens[1:i]) and any(
        t.startswith("kill-ser") for t in tokens[i:]
    ):
        return "refusing `tmux kill-server` — " + _TMUX_HOST_REASON
    # Split tmux's own `;`-chained commands so each is judged on its own words.
    commands: list[list[str]] = [[]]
    for tok in tokens[i:]:
        if tok.endswith(";"):
            if tok[:-1]:
                commands[-1].append(tok[:-1])
            commands.append([])
        else:
            commands[-1].append(tok)
    for cmd in commands:
        if not cmd:
            continue
        word, args = cmd[0], cmd[1:]
        if word.startswith("kill-ser"):
            return "refusing `tmux kill-server` — " + _TMUX_HOST_REASON
        # `source-file -` runs tmux commands read from stdin, which the guard
        # cannot see (`echo kill-server | tmux source -`).
        # Any unique abbreviation of source-file (`so`, `sour`), but not a pane's
        # shell command that merely starts with "so" (`socat -`, `sort -`).
        if len(word) >= 2 and ("source-file".startswith(word) or word == "source") \
                and any(a in ("-", "/dev/stdin") for a in args):
            return "refusing `tmux source-file -` (commands from stdin) — " + _TMUX_HOST_REASON
        # run-shell, if-shell, new-session/-window, split-window, respawn-* and
        # popups all run a shell command: classify that command on its own terms.
        for a in args:
            if " " in a and is_destructive(a):
                return "refusing a shell command run by tmux — " + (is_destructive(a) or "")
        # Many commands take a TMUX command as an argument — if-shell,
        # `run-shell -C`, key bindings, menus, prompts, and hooks, which are
        # options any `set`/`set-h`/`set-option` spelling writes (`set -g
        # session-created kill-server` fires on the agent's next spawn). A list
        # of those names kept missing spellings, so classify EVERY argument as
        # a tmux command, except where the argument is typed text or a name.
        if not word.startswith(("send", "rename", "display-m", "display", "switch")) \
                or word.startswith("display-menu"):
            for a in args:
                if a.startswith("-"):
                    continue
                # tmux's command parser splits a command STRING on `;` even
                # mid-word (`'ls;kill-server'`), unlike argv where only a
                # trailing `;` separates — so split before judging each part.
                for part in a.split(";"):
                    try:
                        inner = shlex.split(part)
                    except ValueError:
                        # tmux closes an unterminated quote at end of string.
                        inner = part.replace("'", " ").replace('"', " ").split()
                    reason = inner and _destructive_agent_tmux(["tmux", *inner])
                    if reason:
                        return reason
        if word.startswith(_TMUX_KILL_TARGET):
            target = None
            all_others = False
            k = 0
            while k < len(args):
                a = args[k]
                if a.startswith("-") and len(a) > 1 and not a.startswith("--"):
                    if "a" in a[1:a.find("t") if "t" in a else None]:
                        all_others = True
                    if "t" in a:
                        rest = a[a.index("t") + 1:]
                        if rest:
                            target = rest
                        elif k + 1 < len(args):
                            target = args[k + 1]
                            k += 1
                        else:
                            target = ""
                k += 1
            if all_others or _tmux_target_is_agent(target):
                return (
                    "refusing to kill a tmux session/window that may be another "
                    "Turma session's agent (`agent-*`, a prefix or glob of it, "
                    "`-a`, or no/unknown target) — " + _TMUX_HOST_REASON
                )
    return None


def _greps_for_tmux(command: str) -> bool:
    """A `pgrep`/`pidof`/`grep` followed by `tmux` in one `;`/`&`/newline piece.

    One regex (`grep[^;&\n]*tmux`) rescanned the piece from every `grep` in it:
    quadratic, and a hook that times out runs the command (XERK-1596).
    """
    for piece in re.split(r"[;&\n]", command):
        m = re.search(r"\b(pgrep|pidof|grep)\b", piece)
        if m and re.search(r"\btmux\b", piece[m.end():]):
            return True
    return False


def _destructive_tmux_pid_kill(command: str) -> str | None:
    """`kill $(pgrep tmux)` / `pgrep tmux | xargs kill` — `pkill tmux` by PID.

    `kill` counts anywhere as a word: wrappers, loops, xargs values and
    newlines all put it somewhere other than a command's first position, and a
    tighter rule reopened those. `pgrep tmux; echo kill` is denied too — the
    accepted, fail-safe cost.
    """
    if _greps_for_tmux(re.sub(r"[\[\]]", "", command)) and re.search(r"(^|[\s;&|(`/'\"\\])kill([\s;&|)`'\"<>]|$)", command):
        return "refusing to kill tmux by PID — " + _TMUX_HOST_REASON
    return None


_PS_POWER = {"stop-computer", "restart-computer", "clear-disk", "format-volume"}


def _destructive_disk_power(tokens: list[str], segment: str) -> str | None:
    prog = _basename(tokens[0])
    if prog in _DISK_PROGS:
        # A pure help/version query destroys nothing, and refusing `shred --help`
        # blocks the agent from reading a man page it may have been sent to.
        if all(t in ("--help", "-h", "--version", "-V") for t in tokens[1:]) and len(tokens) > 1:
            return None
        # `format` is also a benign git/printf word in some contexts, but as
        # argv[0] it is the Windows disk formatter / mkfs family.
        return f"refusing disk-format/partition command ({prog})"
    if prog in _POWER_PROGS:
        return f"refusing host power-state change ({prog})"
    if prog == "init" and len(tokens) > 1 and tokens[1] in ("0", "6"):
        return "refusing host power-state change (init runlevel)"
    if prog.startswith("mkfs."):
        return f"refusing disk-format command ({prog})"
    low = segment.lower()
    if _basename(tokens[0]) in _PS_POWER or any(p in low for p in _PS_POWER):
        return "refusing host power/disk command"
    if prog == "dd" and any(t.lower().startswith("of=/dev/") for t in tokens):
        return "refusing raw write to a block device (dd of=/dev/...)"
    if re.search(r">\s*/dev/(sd|nvme|hd|disk|mmcblk)", low):
        return "refusing redirect onto a block device"
    if re.search(r"\bkill\s+-9\s+-1\b", low) or re.search(r"\bkill\s+-1\b\s+1\b", low):
        return "refusing system-wide kill"
    return None


def _destructive_forkbomb(segment: str) -> str | None:
    compact = re.sub(r"\s+", "", segment)
    if ":(){:|:&};:" in compact:
        return "refusing fork bomb"
    return None


# --- git whole-repo destruction -----------------------------------------

_PROTECTED_BRANCHES = ("main", "master")

# git's own options, which sit BEFORE the subcommand. `-C`, `-c`, `--git-dir`
# and friends each take a value; the rest are bare flags.
_GIT_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                          "--exec-path", "--super-prefix", "--config-env"}
_GIT_GLOBAL_FLAGS = {"-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects",
                     "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
                     "--icase-pathspecs", "--no-optional-locks", "--html-path",
                     "--man-path", "--info-path"}


def _git_args(tokens: list[str]) -> list[str]:
    """`tokens` after `git` and its GLOBAL options, so args[0] is the subcommand.

    Both the destructive check and the push policy used to read `tokens[1]`
    directly, so any global option shifted the subcommand out of view and the
    whole git policy fell away — `git -C /repo push origin main` was allowed,
    and that is the ordinary way to push from outside a worktree, not an
    evasion technique.
    """
    args = list(tokens[1:])
    while args:
        head = args[0]
        if head in _GIT_GLOBAL_WITH_VALUE:
            args = args[2:] if len(args) > 1 else []
            continue
        if head in _GIT_GLOBAL_FLAGS or any(
            head.startswith(o + "=") for o in _GIT_GLOBAL_WITH_VALUE
        ):
            args.pop(0)
            continue
        break
    return args


def _destructive_git(tokens: list[str], segment: str) -> str | None:
    if _basename(tokens[0]) != "git":
        return None
    args = _git_args(tokens)
    if not args:
        return None
    sub = args[0]

    # NB: pushing to a protected branch is handled by `policy_reason` (a hard
    # PR-workflow rule, not an override-able catastrophe). Here we keep only
    # the genuine history-destruction ops a human might legitimately approve.
    if sub == "branch" and ("-D" in args or "--delete" in args or "-d" in args):
        if any(b in args for b in _PROTECTED_BRANCHES):
            return "refusing deletion of a protected branch (main/master)"
        return None
    if sub == "reset" and "--hard" in args:
        # `git reset --hard HEAD~1` etc. is ordinary local work and stays
        # allowed; resetting a protected branch to another ref is the
        # history-losing case the operator wants to gate.
        refs = {a.split("/")[-1] for a in args if not a.startswith("-")}
        if refs & set(_PROTECTED_BRANCHES):
            return "refusing `git reset --hard` onto a protected branch (main/master)"
        return None
    if sub in ("filter-branch", "filter-repo"):
        return "refusing git history rewrite (filter-branch/filter-repo)"
    if sub == "reflog" and "expire" in args and any("--expire=now" in a for a in args):
        return "refusing reflog expiry (destroys recovery history)"
    if sub == "update-ref" and "-d" in args and any(b in segment for b in _PROTECTED_BRANCHES):
        return "refusing deletion of a protected ref"
    return None


def _destructive_chmod_chown(tokens: list[str]) -> str | None:
    prog = _basename(tokens[0])
    if prog not in ("chmod", "chown", "chgrp"):
        return None
    recursive = any(t in ("-R", "--recursive") or (t.startswith("-") and "R" in t) for t in tokens)
    if not recursive:
        return None
    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        # No preserve-root here: `"$x/$y"` is `/` when both are unset (XERK-1687).
        why = _dangerous_target(tok, keep_last=False)
        if why:
            return f"refusing recursive {prog} on a protected path {why}"
    return None


# --- attribution ---------------------------------------------------------

# High-specificity self-attribution signals. Deliberately narrow so a legit
# commit message that merely mentions "anthropic" (e.g. "bump anthropic SDK")
# is NOT blocked — only genuine co-author / generated-by trailers are.
_ATTRIB_PATTERNS = (
    re.compile(r"co-?authored-by:\s*.*(claude|anthropic)", re.IGNORECASE),
    re.compile(r"generated with\s*\[?\s*claude", re.IGNORECASE),
    re.compile(r"noreply@anthropic\.com", re.IGNORECASE),
    re.compile(r"\U0001f916"),  # 🤖
    re.compile(r"claude-session:", re.IGNORECASE),
)
# Only scan commands that author a commit / tag / PR / release message. Every
# PR CLI belongs here, not just GitHub's — the attribution rule is about the
# text, and a description written through `glab` or `az` carries it just as far.
_ATTRIB_CONTEXT = re.compile(
    r"\bgit\s+(commit|tag|merge|revert)\b|\bgh\s+(pr|release)\b"
    r"|\bglab\s+mr\b|\baz\s+repos\s+pr\b|\bado(?:\.py)?\s+pr-create\b"
    r"|--message\b|\bcommit\b.*-m\b",
    re.IGNORECASE,
)


# --- PR workflow policy --------------------------------------------------


def _is_protected_ref(tok: str) -> bool:
    """True if a push refspec token targets main/master (`main`, `HEAD:main`,
    `:main` delete, `origin/main`, `+main`). The remote name (`origin`) is not
    a ref.

    The leading `+` is git's force marker, so `git push origin +main` rewrites
    remote history — strictly worse than the plain spelling this already
    caught, and it slipped through while `+main != main`.
    """
    return any(
        part and part.lstrip("+").split("/")[-1] in _PROTECTED_BRANCHES
        for part in tok.split(":")
    )


def _azdo_completes_pr(tokens: list[str]) -> bool:
    """True if an ``az repos pr`` invocation would MERGE the pull request.

    Azure DevOps has no ``merge`` verb: a PR lands either by being set to the
    ``completed`` status (``az repos pr update --status completed``) or by
    arming auto-complete, which merges it the moment its policies pass —
    including on ``az repos pr create --auto-complete``. Both are the agent
    merging its own work, so both are the policy's business.

    An explicit ``--auto-complete false`` is the agent DISARMING it, and is
    allowed."""
    for i, tok in enumerate(tokens):
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
        if tok == "--status" and nxt.lower() == "completed":
            return True
        if tok.lower() == "--status=completed":
            return True
        if tok == "--auto-complete":
            return nxt.lower() not in ("false", "f", "no", "0")
        if tok.lower().startswith("--auto-complete="):
            return tok.split("=", 1)[1].strip().lower() not in ("false", "f", "no", "0")
    return False


# GitLab push options that arm auto-merge: the push itself schedules the MR to
# merge the moment its pipeline/checks pass — the push-option spelling of
# `glab mr merge`, which is denied. `merge_request.create` and the other
# merge_request.* options stay allowed (the push-option path is the one MR
# creation route that works on every host).
_GITLAB_AUTOMERGE_OPTS = frozenset((
    "merge_request.merge_when_pipeline_succeeds",  # classic spelling
    "merge_request.auto_merge",                    # GitLab >= 17.11 spelling
))


def _gitlab_push_automerges(tokens: list[str]) -> bool:
    """True if a ``git push`` carries a push option arming GitLab auto-merge —
    ``-o <opt>``, ``-o<opt>``, ``--push-option <opt>`` or ``--push-option=<opt>``.

    The option NAME is compared with any ``=value`` stripped: GitLab keeps the
    value as a string and treats ANY non-empty one as truthy (Ruby), so even
    ``merge_request.auto_merge=false`` arms auto-merge server-side — there is
    no value that disarms, hence no value that is safe to allow."""
    for i, tok in enumerate(tokens):
        if tok in ("-o", "--push-option"):
            val = tokens[i + 1] if i + 1 < len(tokens) else ""
        elif tok.startswith("--push-option="):
            val = tok.split("=", 1)[1]
        elif tok.startswith("-o") and len(tok) > 2:
            val = tok[2:]
        else:
            continue
        if val.strip().lower().split("=", 1)[0] in _GITLAB_AUTOMERGE_OPTS:
            return True
    return False


@_budgeted
def policy_reason(command: str) -> str | None:
    """Return a reason if ``command`` violates the PR workflow policy.

    Hard rules (no override): work lands via a pull request, so the agent may
    not push to / delete `main`/`master` directly, and it may not merge any
    pull request — that is a human reviewer's call.
    """
    for tokens, _segment, *_flags in _expand_both(command):
        prog = _basename(tokens[0])
        rest = tokens[1:]
        if prog == "git":
            rest = _git_args(tokens)
        if prog in ("gh", "hub") and "pr" in rest and "merge" in rest:
            return (
                "you must not merge pull requests — open the PR and leave "
                "merging to a human reviewer"
            )
        if prog == "glab" and "mr" in rest and "merge" in rest:
            return (
                "you must not merge merge requests — open the MR and leave "
                "merging to a human reviewer"
            )
        if prog == "az" and "repos" in rest and "pr" in rest and _azdo_completes_pr(rest):
            return (
                "you must not complete pull requests — open the PR and leave "
                "completing it to a human reviewer"
            )
        if prog == "git" and rest and rest[0] == "push":
            if _gitlab_push_automerges(rest[1:]):
                return (
                    "you must not arm auto-merge on a merge request — open "
                    "the MR and leave merging to a human reviewer"
                )
            if any(_is_protected_ref(t) for t in rest[1:] if not t.startswith("-")):
                return (
                    "do not push to main/master directly — push a feature "
                    "branch and open a pull request for review"
                )
    return None


@_budgeted
def attribution_reason(command: str) -> str | None:
    if not _ATTRIB_CONTEXT.search(command):
        return None
    for pat in _ATTRIB_PATTERNS:
        if pat.search(command):
            return (
                "remove AI/self-attribution from the commit/PR message — no "
                "'Co-Authored-By: Claude/Anthropic', 'Generated with Claude', "
                "robot emoji, or anthropic.com trailers (project policy)"
            )
    return None


# --- PR summary standard ---------------------------------------------------

# Every PR/MR a session opens follows one layout, so a reviewer scans each in
# the same order: a plain-English summary line, then these sections. The full
# template and its readability rules ride PR_SUMMARY_SYSTEM_PROMPT in
# hub-agent.py; this is the hard check behind it. A repo's OWN template wins:
# when the repo has one, its headings are what is required instead.
_PR_SUMMARY_LINE = re.compile(r"^\s*\*\*summary:?\*\*", re.IGNORECASE | re.MULTILINE)
_PR_SECTIONS = (
    ("Why", r"why"),
    ("What changed", r"what\s+changed"),
    ("Risk", r"risk"),
    ("Testing", r"testing"),
    ("Follow-ups", r"follow[\s-]?ups?"),
)
# Where GitHub, GitLab and Azure DevOps look for a repo's default template.
_REPO_PR_TEMPLATES = (
    ".github/pull_request_template.md",
    "pull_request_template.md",
    "docs/pull_request_template.md",
    ".gitlab/merge_request_templates/default.md",
    ".azuredevops/pull_request_template.md",
)
# A repo template heading worded as optional is not required of every PR.
_OPTIONAL_HEADING = re.compile(r"optional|if applicable", re.IGNORECASE)
_TEMPLATE_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*#*\s*$", re.MULTILINE)
_PR_BODY_MAX_READ = 256 * 1024


def _heading_present(body: str, pattern: str) -> bool:
    # `(?!\w)`, not `\b`: a template heading may end in `?`/`:`/`)`, after
    # which there is no word boundary at the end of a line.
    return re.search(rf"^\s*#{{1,6}}\s*{pattern}(?!\w)", body,
                     re.IGNORECASE | re.MULTILINE) is not None


# Forge CLIs, the subcommand group, the verbs that open one (`new` is a
# documented alias of `create` for both gh and glab), the long flags that carry
# a description, and the SHORTHAND letters that do (az has none).
_PR_CLIS = {
    "gh": ("pr", ("create", "new"), ("--body", "--body-file"), "bF"),
    "glab": ("mr", ("create", "new"), ("--description",), "d"),
    "az": ("pr", ("create",), ("--description",), ""),
}
# The description sources that name a FILE rather than carry the text.
_PR_FILE_FLAGS = ("--body-file", "F")


def _flag_value(arg: str, flags: tuple[str, ...]) -> tuple[str, str | None] | None:
    """``(flag, glued value or None)`` if ``arg`` is one of the long ``flags``."""
    for f in flags:
        if arg == f:
            return f, None
        if arg.startswith(f + "="):
            return f, arg[len(f) + 1:]
    return None


def _shorthand_value(arg: str, letters: str) -> tuple[str, str | None] | None:
    """``(letter, glued value or None)`` if the single-dash ``arg`` holds a
    description shorthand. pflag reads `-dF x` as a CLUSTER — `-d -F x` — and
    the rest of the cluster after a value-taking letter is its value (`-dFx`,
    `-dF=x`), so a lone `-F`/`-Fx` is just the one-letter case. ANY earlier
    letter is assumed boolean: a glued value holding the letter (`-Rbob/r`)
    over-counts, the safe way, while stopping at a value-taking letter we
    misjudge would let `-dF hosts.yml` slip past the one-source rule."""
    if not letters or not arg.startswith("-") or arg.startswith("--"):
        return None
    for j, ch in enumerate(arg[1:], start=1):
        if ch in letters:
            value = arg[j + 1:]
            if value.startswith("="):
                value = value[1:]
            return ch, (value or None)
        if not ch.isalpha():
            # Shorthands are letters: past a non-letter this is a value.
            return None
    return None


def _pr_body_command(tokens: list[str]) -> tuple[list[str], list[str], int] | None:
    """``(inline bodies, body files, description-flag count)`` if this simple
    command opens a PR/MR or rewrites its description, else None. ``create``
    always carries one; an ``edit``/``update`` only counts when it sets one
    (``gh pr edit --add-label`` is not a description change). Help invocations
    are not PRs."""
    spec = _PR_CLIS.get(_basename(tokens[0]))
    rest = tokens[1:]
    if not spec or spec[0] not in rest:
        return None
    group, creates, body_flags, letters = spec
    head = rest[:rest.index(group)]
    if (rest[:1] == ["help"]
            or (_basename(tokens[0]) == "az" and "repos" not in head)):
        return None
    args = rest[rest.index(group) + 1:]
    verbs = (*creates, "edit", "update")
    # ONE pass over everything after the group, because gh/glab accept any
    # flag on either side of the verb (`gh pr -R o/r create`, `gh pr -b x edit
    # 1`). A bare non-body flag may take the next token as its value, and which
    # ones do differs per CLI, so that token is read as a value — unless it is
    # a verb with no later verb (a boolean: `az repos pr --debug create`).
    verb = subcommand = None
    bodies: list[str] = []
    files: list[str] = []
    seen_flag = False
    sources = 0
    prev_bare = False  # the previous token was a flag that may take a value
    i = 0
    while i < len(args):
        arg = args[i]
        hit = _flag_value(arg, body_flags) or _shorthand_value(arg, letters)
        if hit:
            seen_flag = True
            sources += 1
            flag, value = hit
            if value is None and i + 1 < len(args):
                i += 1
                value = args[i]
            if value is not None:
                (files if flag in _PR_FILE_FLAGS else bodies).append(value)
            prev_bare = False
        elif arg in ("-h", "--help") and not prev_bare:
            # Help prints wherever it sits — unless it is the previous flag's
            # VALUE (`--label -h`), which the CLI sends as that value. The cost
            # of reading it so after ANY bare flag: a refused `--web -h`.
            return None
        elif arg.startswith("-") and len(arg) > 1:
            prev_bare = "=" not in arg
        else:
            # The first POSITIONAL token is the subcommand (`checkout create`
            # checks out a branch named create); a token after a bare flag is
            # that flag's value instead.
            is_value = prev_bare and not (
                arg in verbs and not any(a in verbs for a in args[i + 1:]))
            if subcommand is None and not is_value:
                subcommand = arg
                verb = arg if arg in verbs else None
            prev_bare = False
        i += 1
    if verb in creates or (verb in ("edit", "update") and seen_flag):
        return bodies, [f for f in files if f], sources
    return None


# The names gh's own stdin goes by. Any OTHER /dev or /proc name is a device or
# a file descriptor the shell sets up (`/dev/stderr` + `2<hosts.yml`,
# `//dev/fd/3` + `3<hosts.yml`), which the hook cannot see, so it is refused
# rather than enumerated (XERK-1565: four rounds of one-path-at-a-time fixes).
_PR_STDIN_PATHS = ("/dev/stdin", "/dev/fd/0", "/proc/self/fd/0")
_PR_MAX_LINKS = 40


def _collapse_root(path: str) -> str:
    """POSIX lets `//` lead a path with its own meaning, so normpath keeps it;
    Linux reads it as `/`, and so must the check (`//dev/fd/3`)."""
    return "/" + path.lstrip("/") if path.startswith("//") else path


def _pr_full_path(cwd: str, path: str) -> str:
    return _collapse_root(os.path.normpath(os.path.abspath(_join_path(cwd, path))))


def _pr_kernel_path(path: str) -> bool:
    return path in ("/dev", "/proc") or path.startswith(("/dev/", "/proc/"))


def _pr_description_file(cwd: str, path: str) -> tuple[str, str | None]:
    """What a description FILE argument really is, failing CLOSED:
    ``("stdin", None)`` for `-` or a name that resolves to gh's stdin,
    ``("file", text)`` for a readable regular file outside /dev and /proc,
    ``("missing", None)`` when nothing is there yet, else ``("device", None)``
    (any other /dev or /proc name) or ``("bad", None)`` (anything else: a FIFO,
    a socket, a directory, an unreadable or looping path).

    Symlinks are resolved one component at a time and NEVER through /dev or
    /proc: `os.path.realpath` would follow the hook's OWN /proc/self/fd links,
    which name different fds in gh."""
    if path == "-":
        return "stdin", None
    full = _pr_full_path(cwd, path)
    if os.name != "posix":
        # Git Bash maps /dev and /proc itself; the Windows path never says so.
        raw = _collapse_root(posixpath.normpath(path.replace("\\", "/")))
        if raw in _PR_STDIN_PATHS:
            return "stdin", None
        if _pr_kernel_path(raw):
            return "device", None
        if not os.path.lexists(full):
            return "missing", None
        text = _read_regular(os.path.realpath(full))
        return ("file", text) if text is not None else ("bad", None)
    parts = [c for c in full.split("/") if c]
    resolved = "/"
    links = 0
    while parts:
        name = parts.pop(0)
        if name == ".":
            continue
        if name == "..":
            resolved = os.path.dirname(resolved)
            continue
        cand = os.path.join(resolved, name)
        if _pr_kernel_path(cand):
            rest = _collapse_root(os.path.normpath(os.path.join(cand, *parts)))
            return ("stdin" if rest in _PR_STDIN_PATHS else "device"), None
        try:
            st = os.lstat(cand)
        except FileNotFoundError:
            return "missing", None
        except (OSError, ValueError):
            return "bad", None
        if stat.S_ISLNK(st.st_mode):
            links += 1
            try:
                target = os.readlink(cand)
            except OSError:
                return "bad", None
            if links > _PR_MAX_LINKS:
                return "bad", None
            if target.startswith("/"):
                resolved = "/"
            parts = [c for c in target.split("/") if c] + parts
            continue
        if parts and not stat.S_ISDIR(st.st_mode):
            return "bad", None
        resolved = cand
    text = _read_regular(resolved)
    return ("file", text) if text is not None else ("bad", None)


# A redirect word as the tokenizer leaves it: an optional fd (or `&`), the
# operator, and a target either glued on or in the next token.
_REDIR_WORD = re.compile(r"^(\d*|&)(<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)")


def _drop_leading_redirects(tokens: list[str]) -> list[str]:
    """`< hosts.yml gh pr create -F -` is a PR command too: bash takes a
    redirect before the command word, so the check must look past it."""
    i = 0
    while i < len(tokens):
        m = _REDIR_WORD.match(tokens[i])
        if not m:
            break
        i += 1 if tokens[i][m.end():] else 2
    return tokens[i:]


# Commands that only read, test, print or remove their operands: naming the
# body file (`rm -f b.md; cat > b.md <<EOF …`, `echo using b.md`) cannot put
# other content behind it; nor can `git add`, which only stages it. Their
# OUTPUT redirects still count.
_PR_PATH_READERS = frozenset(("cat", "head", "tail", "wc", "ls", "stat", "test", "[",
                              "grep", "rm", "unlink", "echo", "printf"))


def _note_paths(tokens: list[str], segment: str, cwd: str,
                written: set[str], named: set[str]) -> None:
    """Record what a NON-PR segment of the command does to paths — before or
    after the PR command, run or not: expansion keeps no source order or
    condition. ``written``: a heredoc-only writer's outputs — `cat > f <<EOF`,
    `cat >> f`, `tee [-a] f <<EOF` with no other input — the one way a
    description file may be filled by the same command (which is why an
    existing one must still pass alone). ``named``: every other path it mentions
    (`ln -sf /dev/stdin f`, `cp hosts.yml f`, `cat hosts.yml <<EOF > f`)."""
    words: list[str] = []
    outs: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        m = _REDIR_WORD.match(tok)
        if not m:
            words.append(tok)
            i += 1
            continue
        fd, op = m.group(1), m.group(2)
        target = tok[m.end():]
        if not target and i + 1 < len(tokens):
            i += 1
            target = tokens[i]
        i += 1
        if op in ("<<", "<<-", "<<<") or (op in ("<&", ">&") and
                                          (target.isdigit() or target == "-")):
            continue  # a heredoc delimiter, a here-string, an fd dup
        if op in (">", ">>", ">|", ">&") and fd in ("", "1", "&"):
            outs.append(target)
        elif target:
            named.add(_pr_full_path(cwd, target))
    here, other = _stdin_redirects(segment)
    cmd = _basename(words[0]) if words else ""
    writer = here == 1 and other == 0 and (
        (cmd == "cat" and all(w == "-" for w in words[1:])) or cmd == "tee")
    if writer and cmd == "tee":
        outs += [w for w in words[1:] if not w.startswith("-")]
        words = words[:1]
    elif cmd in _PR_PATH_READERS or (cmd == "git" and words[1:2] == ["add"]):
        words = words[:1]  # it reads or removes its operands, never fills one
    for out in outs:
        (written if writer else named).add(_pr_full_path(cwd, out))
    for word in words[1:]:
        named.add(_pr_full_path(cwd, word))


def _stdin_redirects(segment: str, any_fd: bool = False) -> tuple[int, int]:
    """``(heredocs, other inputs)`` redirected onto fd 0 by ``segment``'s own
    text — onto ANY fd with ``any_fd``. Other inputs are `<`, `<>`, `<&` and
    the here-string `<<<`; a `0<`-style prefix counts, `3<` only with
    ``any_fd``. Quotes are skipped, and a `<` glued into a word (`-F-<h`)
    still counts, as bash parses it."""
    here = other = 0
    i, n = 0, len(segment)
    while i < n:
        ch = segment[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "'":
            end = segment.find("'", i + 1)
            i = n if end < 0 else end + 1
            continue
        if ch == '"':
            j = i + 1
            while j < n and segment[j] != '"':
                j += 2 if segment[j] == "\\" else 1
            i = j + 1
            continue
        if ch != "<":
            i += 1
            continue
        j = i
        while j > 0 and segment[j - 1].isdigit():
            j -= 1
        # Digits are the fd only when they are the whole word (`a0<x` is the
        # word `a0` and a redirect of fd 0).
        word_start = j == 0 or segment[j - 1].isspace() or segment[j - 1] in ";&|()<>"
        on_zero = any_fd or j == i or not word_start or int(segment[j:i]) == 0
        if segment.startswith("<<<", i):
            other += on_zero
            i += 3
        elif segment.startswith("<<", i):
            here += on_zero
            i += 2
        elif segment.startswith("<(", i):
            i += 2  # process substitution: a path, not a redirect
        else:
            other += on_zero
            i += 1
    return here, other


def _read_regular(path: str) -> str | None:
    """A bounded read of a REGULAR file, else None. ``O_NONBLOCK`` + the fstat
    check keep a FIFO planted at the path from hanging the hook, which Claude
    Code would then time out and let the command through unchecked."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except (OSError, ValueError):
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        return os.read(fd, _PR_BODY_MAX_READ).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)


def _read_text(path: str) -> str:
    """`_read_regular`, with "" for anything it can't read."""
    return _read_regular(path) or ""


def _repo_root(start: str) -> str | None:
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _repo_template_sections(root: str | None) -> list[tuple[str, str]] | None:
    """The required headings of the repo's own PR template; ``[]`` when its
    template has no headings (nothing to check against), None when it has no
    template. Matched case-insensitively, since GitHub accepts any case for the
    name."""
    if not root:
        return None
    for rel in _REPO_PR_TEMPLATES:
        dirname, name = os.path.split(os.path.join(root, rel))
        try:
            entries = os.listdir(dirname)
        except OSError:
            continue
        match = next((e for e in entries if e.lower() == name), None)
        if not match:
            continue
        text = _read_text(os.path.join(dirname, match))
        if not text.strip():
            # Unreadable, a FIFO, or empty: no template to follow, so the
            # standard applies rather than nothing at all.
            return None
        heads = [h for h in _TEMPLATE_HEADING.findall(text)
                 if not _OPTIONAL_HEADING.search(h)]
        return [(h, re.escape(h)) for h in heads]
    return None


def _join_path(cwd: str, path: str) -> str:
    try:
        return os.path.join(cwd, os.path.expanduser(path))
    except ValueError:  # an embedded NUL: nothing real lives there
        return cwd


@_budgeted
def pr_summary_reason(command: str, cwd: str | None = None) -> str | None:
    """A reason if ``command`` opens a PR/MR (or rewrites its description)
    whose description is missing a required section.

    The description is the ONE source the command would actually send: a
    regular ``--body-file`` (resolved against ``cwd`` as moved by a preceding
    ``cd``) is checked alone; a stdin body against each heredoc on its own; an
    inline ``--body``/``--description`` value, or a body file a heredoc writer
    in the same command fills, together with the command's heredoc bodies —
    which covers ``$(cat <<EOF …)`` and ``cat > f <<EOF; … -F f``. A stdin
    description must be the PR command's own heredoc — a `< file`, `<<<`, pipe
    or sibling heredoc is what gh would read instead. A description FILE fails
    closed: a regular file outside /dev and /proc, or one a heredoc writer
    in the command fills (an existing one must ALSO pass alone, since the
    writer may append, not run, or run after gh); any other path is refused. The rest of
    the command text (titles, comments) never counts. A description pulled from
    somewhere else (``--fill``, the editor, ``$(cat file)``) can't be checked,
    so it is refused with a reason saying how to pass it."""
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = "/"
    heredocs = None
    written: set[str] = set()  # description files a heredoc writer creates first
    named: set[str] = set()  # every other path an earlier segment mentions
    # Without the `~` reading (XERK-1685): it repeats the line, and a writer
    # read twice is "another part" naming the file it wrote.
    for tokens, segment, *_flags in _expand_both(command, home=False):
        if _basename(tokens[0]) == "cd" and len(tokens) > 1:
            cwd = _join_path(cwd, tokens[1])
            continue
        command_tokens = _drop_leading_redirects(tokens)
        hit = _pr_body_command(command_tokens) if command_tokens else None
        if not hit:
            _note_paths(tokens, segment, cwd, written, named)
            continue
        bodies, files, sources = hit
        if sources > 1:
            # The check below reads the UNION of every description source,
            # but gh/glab/az send only ONE (gh's pflag keeps the last), so
            # `--body-file ok.md --body-file ~/.config/gh/hosts.yml` passed on
            # ok.md's sections and posted the other file (XERK-1565).
            return (
                "the command passes the description more than once "
                "(--body/-b, --body-file/-F, --description/-d, a letter in a "
                "flag cluster such as -dF counts too) — the CLI sends only one of "
                "them, so the description that is checked may not be the one "
                "that is sent. Pass the description exactly once."
            )
        if files and _stdin_redirects(segment, any_fd=True)[1]:
            # The heredoc check below reads every heredoc, but `-F - <<EOF
            # < hosts.yml` (or `0<`, `<<<`, `<&3`) hands gh the LAST fd-0
            # input — the token file — while the heredoc passes; and a file
            # name can turn into an fd (`-F /dev/stderr 2<hosts.yml`), so an
            # input redirect on ANY fd counts (XERK-1565).
            return (
                "the description is read from a file while the command also "
                "redirects an input (<, N<, <<<, <&) — the input gh reads may "
                "not be the description that is checked. Pass the description "
                "with --body-file <path>, or as a heredoc on the PR command "
                "itself (-F - <<'EOF') with no other input redirect."
            )
        stdin = False
        texts: list[str] = []
        current: list[tuple[str, str]] = []  # a writer's file as it is NOW
        from_writer = False
        for f in files:
            # FAIL CLOSED (XERK-1565): `-`/stdin under the own-heredoc rule, a
            # regular file outside /dev and /proc, or a file a heredoc writer
            # in this command creates first. Nothing else is a description.
            kind, text = _pr_description_file(cwd, f)
            # Path STRINGS only: another spelling of the same file ("$PWD/f",
            # /proc/self/cwd/f, a glob, a symlinked dir made in this line)
            # gets past it — a documented residual (agent-hooks.md), not a
            # credential filter.
            if kind != "stdin" and _pr_full_path(cwd, f) in named:
                return (
                    "another part of the command names the description file "
                    f"({f}) — it can replace or relink it before gh reads it, so "
                    "the file that is checked may not be the one that is sent. "
                    "Write it with cat > <path> <<'EOF' (or in an earlier step) "
                    "and pass --body-file <path>, or use a heredoc."
                )
            if kind == "stdin":
                stdin = True
            elif kind in ("file", "missing") and _pr_full_path(cwd, f) in written:
                # A heredoc writer in this command fills it, so its heredoc
                # is checked (below). But `written` keeps no order or
                # condition: an APPENDING writer (`>>`, `tee -a`), one gated
                # by `false &&`, or one in a later `(…)`/`$(…)` (expanded
                # first) leaves what is there NOW in what gh reads, so an
                # existing file must pass ALONE too — or `cat >> .env <<EOF`
                # posted .env on the heredoc's sections (XERK-1565).
                from_writer = True
                if kind == "file":
                    current.append((f, text or ""))
            elif kind == "file":
                texts.append(text or "")
            elif kind == "device":
                return (
                    f"the description is read from a device or file-descriptor "
                    f"path ({f}) the check can't see — only - or /dev/stdin "
                    "(as a heredoc on the PR command) is. Pass it with "
                    "--body-file <path>, inline (--body/--description) or as a "
                    "heredoc."
                )
            elif kind == "missing":
                return (
                    f"the description file ({f}) does not exist and is not "
                    "written by a heredoc earlier in this command (cat > <path> "
                    "<<'EOF'), so the check can't see what gh will read. Write "
                    "it first, pass it inline (--body/--description) or as a "
                    "heredoc."
                )
            else:
                return (
                    f"the description file ({f}) is not a readable regular file "
                    "(a FIFO, socket, directory or unreadable path), so the check "
                    "can't see what gh will read. Pass it with --body-file <path> "
                    "to a regular file, inline (--body/--description) or as a "
                    "heredoc."
                )
        if stdin and _stdin_redirects(segment)[0] != 1:
            # A stdin description must BE the PR command's own heredoc: one
            # fed by a pipe, an inherited stdin or a sibling segment's heredoc
            # (`gh pr create -F - < f; gh pr view 1 <<EOF`) is not what is
            # checked.
            return (
                "the description is read from standard input, but not from a "
                "heredoc on the PR command itself — the input gh reads may not "
                "be the description that is checked. Use -F - <<'EOF' on the "
                "PR command, --body \"$(cat <<'EOF' …)\", or --body-file <path>."
            )
        if heredocs is None:
            heredocs = [b for _owner, b, _quoted in _split_heredocs(command)[1]]
        # What gh sends — exactly one source by now (XERK-1565):
        # - a regular FILE is checked ALONE: a heredoc gh never reads must not
        #   vouch for it (`--body-file hosts.yml <<EOF …`);
        # - STDIN is its own heredoc, but which one that is in a multi-heredoc
        #   command is not mapped, so EVERY heredoc must pass on its own (two
        #   `gh pr edit N -F - <<EOF` pass; a good sibling can't vouch for a
        #   bad one);
        # - an inline body or a file a heredoc writer fills is checked with
        #   every heredoc (and an existing such file alone too, after this).
        #   Matching a heredoc to the command it feeds (owner line, redirect
        #   target) refused 26% of real compliant PR commands —
        #   `git push && gh pr create … <<EOF`, `cd x && …`, `cat > "$S/b.md"`
        #   — so an unrelated heredoc counts there: the accepted residual,
        #   since it takes a model gaming its own guard. (`<<` in
        #   quotes/comments is not a heredoc to the XERK-1256 lexer.)
        # With no source at all (--fill, the editor) nothing is checked
        # against, so it is refused.
        if texts:
            candidates = texts
        elif stdin:
            candidates = heredocs or [""]
        elif bodies or from_writer:
            candidates = ["\n".join(bodies + heredocs)]
        else:
            candidates = [""]
        for body in candidates:
            reason = _pr_body_reason(body, cwd)
            if reason:
                return reason
        for f, body in current:
            reason = _pr_body_reason(body, cwd)
            if reason:
                return (
                    f"the description file ({f}) already exists and its current "
                    "text fails the check — a heredoc in this command writes it, "
                    "but an appending (>>, tee -a), conditional or later writer "
                    "leaves that text in what gh reads. Remove it in an earlier "
                    "step or write the description to a new path. " + reason
                )
    return None


def _pr_body_reason(body: str, cwd: str) -> str | None:
    """Why ``body`` misses the repo's PR template (or, with none, the Turma
    PR summary standard), else None."""
    sections = _repo_template_sections(_repo_root(cwd))
    if sections is not None:
        # A template with no headings asks for prose; there is nothing to check.
        missing = [name for name, pat in sections if not _heading_present(body, pat)]
        if missing:
            return (
                "this repo has its own PR template — the description is missing "
                f"its section(s): {', '.join(missing)}. Follow that template, "
                "and pass the description inline (--body/--description, or a "
                "heredoc) or with --body-file so it can be checked."
            )
        return None
    missing = [name for name, pat in _PR_SECTIONS if not _heading_present(body, pat)]
    if not _PR_SUMMARY_LINE.search(body):
        missing.insert(0, "a '**Summary:**' first line")
    if missing:
        return (
            "the PR description does not follow the Turma PR summary standard — "
            f"missing: {', '.join(missing)}. Required, in order: a "
            "'**Summary:**' line, then '## Why', '## What changed', '## Risk', "
            "'## Testing', '## Follow-ups' (see the PR summary standard in your "
            "system prompt). Pass the description inline (--body/--description, "
            "or a heredoc) or with --body-file so it can be checked — --fill and "
            "the editor can't be."
        )
    return None


# --- top-level classification -------------------------------------------


# Whole-database / schema destruction, typically issued through a db CLI
# (`psql -c "DROP DATABASE x"`, `dropdb x`, mongo `db.dropDatabase()`).
_DB_DESTRUCTION = re.compile(
    r"\bdrop\s+database\b|\bdrop\s+table\b|\bdropdb\b|\bdropdatabase\s*\(",
    re.IGNORECASE,
)


# Programs that only ever READ or QUOTE text. `DROP TABLE` inside their
# arguments is a search string or a commit message, not a statement anything
# will execute — matching the raw command string meant `grep -rn 'DROP TABLE'
# migrations/` and `git commit -m 'drop table x from the doc'` were refused,
# with a reason that did not apply and no way to override.
_TEXT_PROGS = {
    "grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "bat", "echo", "printf",
    "less", "more", "head", "tail", "awk", "sed", "tee", "git", "diff", "comm",
    "sort", "uniq", "wc", "strings", "jq", "yq", "find", "ls", "man",
}


# Programs that EXECUTE SQL they are fed. A heredoc or pipeline carrying
# `DROP DATABASE` only drops one when it reaches one of these; fed to `python3`
# or `cat` it is a string in a script, which is why this is a named list rather
# than "anything that is not a text tool".
_DB_CLIENTS = {
    "psql", "mysql", "mariadb", "mysqldump", "sqlite3", "sqlite", "mongo",
    "mongosh", "cqlsh", "sqlcmd", "clickhouse-client", "cockroach", "usql",
    "duckdb", "impala-shell", "beeline", "snowsql", "pgcli", "mycli",
    "dropdb", "dropuser",
}

# Programs that RUN another program, carrying the real client in their
# arguments. The agent image ships all of these.
_EXEC_WRAPPERS = {
    "docker", "podman", "kubectl", "oc", "ssh", "nsenter", "chroot",
    "docker-compose", "flatpak", "distrobox", "lxc", "incus", "flock",
}

# How many non-option OPERANDS sit between the wrapper and the command it runs:
# `ssh <host> <cmd>` is one, `docker exec <container> <cmd>` is two (the
# subcommand and the target). Used to find the command in the UNQUOTED form; the
# quoted form (`ssh h '<cmd>'`) arrives as one token and is handled separately.
_EXEC_WRAPPER_OPERANDS = {
    "ssh": 1, "nsenter": 0, "chroot": 1,
    "docker": 2, "podman": 2, "kubectl": 2, "oc": 2,
    "docker-compose": 2, "flatpak": 2, "distrobox": 2, "lxc": 2, "incus": 2,
    "flock": 1,
}

# Wrapper options that consume the NEXT token as their value. Without these the
# VALUE eats an operand slot and the command is missed entirely: `ssh -i key
# host rm -rf /etc` counted `key` as the host and returned `['host','rm',…]`.
# Same shape, and the same reason, as _PREFIX_OPTS_WITH_VALUE.
# This table cannot be kept complete — value-taking options are many and grow
# every release — so `_expand_segments` also classifies every non-option SUFFIX
# of a wrapper's argv, which finds an UNQUOTED command wherever it starts. For
# that form a missing option costs sharpness, not safety.
#
# BEHIND AN UNLISTED OPTION, though, this table is still the boundary — for more
# than the quoted case, so do not delete an entry believing the suffix pass
# covers it. What is still missed when an option is absent from here:
#   * a QUOTED command — the operand count is the only thing distinguishing it
#     from a quoted MESSAGE (`ssh host git commit -m 'rm -rf /etc is banned'`);
#   * any DISK/POWER command — suffix candidates skip the argv[0]-only rules, so
#     that a container named `reboot` is not a power command (the `/dev/` carve-
#     out in is_destructive recovers the device-bearing half);
#   * a command after a printer-NAMED operand (`docker exec cat rm -rf /etc`);
#   * a command needing re-expansion (`find / -delete`, `eval …`, `bash -c '…'`),
#     because suffix candidates are terminal and are not expanded again.
# Keep the table complete; the suffix pass does not make it optional.
_EXEC_WRAPPER_OPTS_WITH_VALUE = {
    "ssh": {"-i", "-p", "-o", "-l", "-F", "-c", "-m", "-b", "-B", "-D", "-e",
            "-E", "-I", "-J", "-L", "-O", "-Q", "-R", "-S", "-W", "-w"},
    "docker": {"-u", "--user", "-w", "--workdir", "-e", "--env", "--context",
               "-c", "--config", "-H", "--host", "--detach-keys", "--env-file",
               "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"},
    "podman": {"-u", "--user", "-w", "--workdir", "-e", "--env", "--url",
               "--connection", "--detach-keys", "--env-file", "--log-level"},
    "kubectl": {"-n", "--namespace", "--context", "--cluster", "--user", "-c",
                "--container", "--kubeconfig", "--as", "--as-group", "--token",
                "-s", "--server", "-v", "--tls-server-name", "--request-timeout",
                "--certificate-authority", "--client-certificate", "--client-key",
                "--pod-running-timeout"},
    "oc": {"-n", "--namespace", "--context", "--cluster", "--user", "-c",
           "--container", "--kubeconfig", "--as", "--token", "-s", "--server"},
    "chroot": {"--userspec", "--groups", "--skip-chdir"},
    "nsenter": {"-t", "--target", "-S", "--setuid", "-G", "--setgid",
                "-r", "--root", "-w", "--wd"},
    "lxc": {"--project", "--env", "--user", "--group", "--cwd"},
    "incus": {"--project", "--env", "--user", "--group", "--cwd"},
    "docker-compose": {"-f", "--file", "-p", "--project-name", "--project-directory",
                       "--env-file", "--profile", "-c", "--context"},
    "flatpak": {"--command", "--branch", "--arch", "--env", "--filesystem"},
    "distrobox": {"-n", "--name", "-e", "--extra-flags"},
    "flock": {"-w", "--wait", "--timeout", "-E", "--conflict-exit-code"},
}

# Wrappers whose remaining operands are JOINED into one command line for a
# remote shell, rather than exec'd as an argv: `ssh host 'rm -rf /etc' 'b'`
# really runs `rm -rf /etc b`. `docker exec`/`kubectl exec` do NOT join.
_JOINING_WRAPPERS = {"ssh", "chroot"}

# Programs whose remaining arguments are DATA. Used by the wrapper suffix pass
# to stop treating later tokens as command starts.
_ARG_ONLY_PROGS = _ECHO_PROGS | _TEXT_PROGS | {"logger", "notify-send", "say"}


def _wrapper_command(prog: str, rest: list[str]) -> list[str]:
    """The command a wrapper runs, in its unquoted form, or []."""
    if "--" in rest:
        return rest[rest.index("--") + 1:]
    remaining = _EXEC_WRAPPER_OPERANDS.get(prog, 1)
    takes_value = _EXEC_WRAPPER_OPTS_WITH_VALUE.get(prog, set())
    i = 0
    # Leading options are skipped even when no operand is expected — `nsenter`
    # takes 0 operands, and without this it returned its own flags as the
    # command, with `-t` as the program.
    while i < len(rest):
        tok = rest[i]
        if tok.startswith("-") and len(tok) > 1:
            if "=" not in tok and tok in takes_value:
                i += 1
            i += 1
            continue
        if remaining == 0:
            break
        remaining -= 1
        i += 1
    return rest[i:] if remaining == 0 else []


def _stage_executes_sql(tokens: list[str], depth: int = 0) -> bool:
    """True if SQL reaching this command would actually be EXECUTED.

    Deliberately narrow on both sides. A text tool never executes what it is
    handed, so `grep -rn 'DROP TABLE' migrations/` is fine; but "not a text
    tool" was far too wide the other way — it refused `python3 -c "print('DROP
    TABLE')"`, `make lint  # catches DROP TABLE`, and even a `gh issue create`
    whose TITLE proposed blocking the statement. All it takes is naming the
    thing. A wrapper is checked through to its arguments, so
    `docker exec -i db psql` is still the database client it runs.
    """
    if not tokens:
        return False
    # Each level strips a wrapper or a `-c`, so this terminates on its own; the
    # cap is a backstop against a pathological nest. It fails CLOSED, unlike
    # _expand_segments: that returns a LIST and exhaustion means "no more
    # commands found", whereas this returns a verdict on text already known to
    # contain a database drop, so "ran out of budget deciding" should deny.
    # Measured to change no verdict either way — real commands reach depth 0-2.
    if depth > _MAX_EXPAND_DEPTH:
        return True
    prog = _basename(tokens[0])
    if prog in _DB_CLIENTS:
        return True
    if prog in _TEXT_PROGS:
        return False
    if prog in _SHELL_PROGS:
        # A shell is only an executor of whatever it is GIVEN. Concluding from
        # the shell alone denied `sh -c 'grep "DROP TABLE" schema.sql'`, which
        # runs grep. With no `-c` it reads stdin, so a pipeline into it does.
        script = _shell_c_script(tokens[1:])
        if script is not None:
            return _stage_executes_sql(_tokenize(script), depth + 1)
        return True
    if prog in _EXEC_WRAPPERS:
        # Skip the wrapper's own options and target, then classify the command it
        # RUNS on its own terms. The remote command usually arrives quoted, as a
        # single token whose basename is the whole string (`ssh db 'psql -c …'`).
        for idx in range(1, len(tokens)):
            base = _basename(tokens[idx])
            if base in _DB_CLIENTS or base in _SHELL_PROGS:
                return _stage_executes_sql(tokens[idx:], depth + 1)
            # The remote command can be COMPOUND — `ssh h 'cd /tmp && psql -c …'`
            # classified as `cd` when read as one argv. Only the severed-quote
            # bug was catching those before it was fixed.
            for part in _split_on_operators(tokens[idx]):
                words = _tokenize(part)
                if len(words) > 1 and _stage_executes_sql(words, depth + 1):
                    return True
    return False


def _destructive_database(command: str) -> str | None:
    for tokens, segment, *_flags in _expand_both(command):
        if not _DB_DESTRUCTION.search(segment):
            continue
        if not _stage_executes_sql(tokens):
            continue
        return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    # A pipeline is ONE statement crossing several segments: in
    # `echo 'DROP DATABASE prod' | mysql` the SQL sits in the exempt `echo`
    # stage while the stage that executes it carries no SQL of its own, so
    # judging stages separately cleared both halves. Judge the pipeline whole —
    # it is destructive if any stage is something other than a text tool.
    try:
        flat = _prenormalise(_split_heredocs(command)[0])
    except _ExpansionTooLarge:
        # Not a pass: `_expand_segments` grows the same text by at least as
        # much, so `is_destructive` refuses it as `_TOO_LARGE` below.
        flat = ""
    for pipeline in _split_on_operators(flat, include_pipe=False):
        if not _DB_DESTRUCTION.search(pipeline):
            continue
        for stage in _split_on_operators(pipeline, include_pipe=True):
            toks = _strip_prefixes(_tokenize(_unwrap_group(_SUBST_RE.sub(" ", stage))))
            if _stage_executes_sql(toks):
                return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    # A heredoc body is data, but `psql <<EOF ... DROP DATABASE x; ... EOF` is
    # still the statement being executed — judge it by the command it feeds.
    # Heredocs on one line share it as their owner: judge each owner once.
    judged: set[str] = set()
    for owner, body, _quoted in _split_heredocs(command)[1]:
        if owner in judged or not _DB_DESTRUCTION.search(body):
            continue
        judged.add(owner)
        # Both readings: an escaped `\$(…)` program is live once `bash -c` re-parses.
        for tokens, _seg, *_flags in _expand_both(owner):
            if _stage_executes_sql(tokens):
                return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    return None


# The one line a single-quoted `$(…)`/backtick is let through as text
# (XERK-1541): a bare `git commit` whose messages are single-quoted literals.
# Matched on the RAW line, never shlex words — every scoping of "nothing runs
# it" through the parser leaked (XERK-1256: pipes, `printf -v GIT_EDITOR`,
# `--trailer` and its abbreviations, `$"…"`, globs, multi-word expansions).
# Outside the quotes only fixed words and blanks may appear, so there is no
# `$`, backtick, `"`, backslash, glob, operator, redirect, newline, env
# prefix, wrapper or other option for bash to act on; `-m` is required, so git never
# starts GIT_EDITOR, and no option here hands the message to a shell.
_COMMIT_FLAG = r"[ \t]+(?:-a|--all|-s|--signoff|-q|--quiet|-n|--no-verify|--amend|--allow-empty)"
_COMMIT_MSG = r"[ \t]+-a?m[ \t]+'[^']*'"
# The first `-m` is the required one, so no `-m` can be matched two ways.
_LITERAL_COMMIT_RE = re.compile(
    rf"[ \t]*git[ \t]+commit(?:{_COMMIT_FLAG})*{_COMMIT_MSG}"
    rf"(?:{_COMMIT_FLAG}|{_COMMIT_MSG})*[ \t]*\n?")


@_budgeted
def is_destructive(command: str) -> str | None:
    """Return a human reason if ``command`` is catastrophic, else ``None``."""
    if _LITERAL_COMMIT_RE.fullmatch(command):
        return None
    # Fork bombs contain the `;`/`|` we segment on, so match the whole string.
    reason = _destructive_forkbomb(command)
    if reason:
        return reason
    reason = _destructive_tmux_pid_kill(command)
    if reason:
        return reason
    reason = _destructive_database(command)
    if reason:
        return reason
    for tokens, segment, *flags in _expand_both(command):
        if tokens[0] == _TOO_DEEP:
            return "refusing a command nested too deeply to classify — flatten it"
        if tokens[0] == _UNREAD_PROG:
            return ("refusing a command whose program name is the output of a substitution the "
                    "guard cannot read, given printed arguments — name the program directly")
        if tokens[0] == _TOO_LARGE:
            return _TOO_LARGE_REASON
        # A candidate recovered by the wrapper SUFFIX pass is a guess at where
        # the command starts, so only the rules that also require a dangerous
        # PATH run on it. `_destructive_disk_power` matches on argv[0] ALONE, and
        # `reboot`/`shutdown`/`halt`/`shred` are ordinary container and pod
        # names — `docker exec reboot ls` must not read as a power command
        # (XERK-235).
        from_suffix = bool(flags and flags[0])
        checks = [
            _destructive_rm(tokens),
            _destructive_chmod_chown(tokens),
            _destructive_git(tokens, segment),
        ]
        if not from_suffix:
            checks.append(_destructive_disk_power(tokens, segment))
            checks.append(_destructive_powershell_remove(segment))
        elif any(t.lower().startswith(("/dev/", "of=/dev/")) for t in tokens[1:]):
            # ...unless it names a BLOCK DEVICE. A container is never called
            # `/dev/sda`, so this recovers `mkfs.ext4 /dev/sda1`, `dd of=/dev/sda`
            # and `wipefs -a /dev/sda` behind an unlisted option without bringing
            # back the container-named-`reboot` false positive.
            checks.append(_destructive_disk_power(tokens, segment))
        # Taking the agent's own service down (PR #410) applies to a
        # suffix-derived candidate too: it needs no dangerous path, but it names
        # specific units, so a container called `reboot` cannot trip it.
        checks.append(_destructive_agent_service(tokens))
        checks.append(_destructive_agent_tmux(tokens))
        for reason in checks:
            if reason:
                if len(flags) > 1:
                    # Joined to a cwd the session never typed: say where from.
                    reason += (f" — read from inside {flags[1]!r}, where a `cd` on this line"
                               " may have left it; name the target by absolute path")
                return reason
    return None


def _parse_overrides(raw: str | None) -> list[str]:
    """Extract approved command patterns from a ``Bash(<cmd>),...`` CSV grant.

    Only ``Bash(...)`` entries are command overrides; bare tool names (e.g.
    ``Edit``) are irrelevant to this hook and ignored.
    """
    if not raw:
        return []
    out: list[str] = []
    for m in re.finditer(r"Bash\((.*?)\)\s*(?:,|$)", raw):
        inner = m.group(1).strip()
        if inner:
            out.append(inner)
    return out


def _norm_cmd(command: str) -> str:
    return re.sub(r"\s+", " ", command).strip()


def command_overridden(command: str, overrides: list[str]) -> bool:
    cmd = _norm_cmd(command)
    for ov in overrides:
        pat = _norm_cmd(ov)
        if pat.endswith("*"):
            if cmd.startswith(pat[:-1].strip()):
                return True
        elif cmd == pat:
            return True
    return False


@_budgeted
def decide(
    tool_name: str,
    tool_input: dict,
    *,
    overrides: list[str] | None = None,
    no_attribution: bool = True,
    pr_summary: bool = True,
    cwd: str | None = None,
) -> tuple[str, str | None, str | None]:
    """Return ``(decision, reason, category)``.

    ``decision`` is ``"allow"`` or ``"deny"``. ``category`` is
    ``"destructive"`` / ``"policy"`` / ``"attribution"`` / ``"pr-summary"`` /
    ``None``. Only
    ``"destructive"`` honours an operator override grant; the others are hard
    rules the agent self-corrects from.
    """
    overrides = overrides or []
    if tool_name != "Bash":
        return ("allow", None, None)
    command = (tool_input or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        return ("allow", None, None)

    reason = is_destructive(command)
    # A line too large to read is never grantable: a spent budget, or a cap
    # on readings (`_expand_picks`). Past a cap the policy checks below see
    # none of the per-value readings, so a grant let `x=ls; <17 x=…>;
    # x="gh pr merge 1"; $x` through (XERK-1621 QA) — checked here and again
    # last, since a grantable reason found first returns before the cap.
    if _budget["left"] < 0 or _budget["capped"] or reason == _TOO_LARGE_REASON:
        return ("deny", _TOO_LARGE_REASON, "policy")
    if reason and not command_overridden(command, overrides):
        return ("deny", reason, "destructive")

    # PR workflow rules are hard (no override): always open a PR, never
    # self-merge.
    pol = policy_reason(command)
    if pol:
        return ("deny", pol, "policy")

    if no_attribution:
        attrib = attribution_reason(command)
        if attrib:
            return ("deny", attrib, "attribution")

    if pr_summary:
        summary = pr_summary_reason(command, cwd)
        if summary:
            return ("deny", summary, "pr-summary")

    # Not grantable: the budget replaces the WHOLE expansion, so the checks
    # above saw nothing. A granted reason found before any expansion (a heredoc
    # fed to psql, a fork bomb) let it run out inside them, and `gh pr merge`
    # through — so it is checked here, last, as well as before the grant.
    # Likewise a cap on readings.
    if _budget["left"] < 0 or _budget["capped"]:
        return ("deny", _TOO_LARGE_REASON, "policy")
    return ("allow", None, None)


# --- the permission judge's one-shot grants (XERK-1566) --------------------
#
# The manager's permission judge (hub-agent.py) may approve a Bash call the
# auto-mode classifier blocked. It writes a ONE-SHOT grant under
# `~/.turma/grants/<session id>/<sha256 of the command>`; on the retried call
# this hook consumes it and emits `allow`, which overrides the classifier. It is
# consulted ONLY after decide() allowed the command, so every hard deny above
# still wins, and a grant is never a reason to skip a check.
#
# The directory is same-uid and Bash can write it (the documented ~/.turma
# residual, .claude/rules/agent-hooks.md), so this read is defensive rather than
# trusting: O_NONBLOCK + O_NOFOLLOW + regular-file only + bounded (a FIFO planted
# at the path would hang the hook, and Claude Code lets a timed-out hook's
# command THROUGH); the grant must name this session and this exact command and
# be unexpired. Consumed by unlink BEFORE it allows: of two racing calls that
# both read it, only the one whose unlink succeeded is allowed.

GRANT_SID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
GRANT_MAX_BYTES = 4096
# The judge writes a 120s TTL; a grant claiming a longer life was not written
# by the judge, and is ignored rather than honoured for longer.
GRANT_TTL_MAX_SEC = 300
GRANT_REASON_MAX = 300


def grant_key(command: str) -> str:
    """The file name a grant for this exact command lives under. The judge
    (hub-agent.py `judge_grant_key`) computes the same — parity-tested."""
    return hashlib.sha256(command.encode("utf-8", "surrogatepass")).hexdigest()


# The argv flag the manager's `build_guard_settings` adds to this hook's command
# only while the permission judge is on. Without it no grant is ever honoured:
# the switch rides each session's own settings (written per launch), not an env
# var the long-lived tmux server would keep from whenever it started.
GRANTS_FLAG = "--grants"

# The root-owned copy wired through managed settings (XERK-1677) runs with this
# flag, and then takes its operator overrides from a root-owned file, never the
# environment: a session can start a nested `claude` with
# `TURMA_TOOL_GRANTS='Bash(*)'`, and the hook inherits claude's env.
PROTECTED_FLAG = "--protected"
PROTECTED_ENV_FILE = "/etc/turma-agent/guard.env"
_PROTECTED_KEYS = ("TURMA_TOOL_GRANTS", "TURMA_NO_ATTRIBUTION", "TURMA_PR_SUMMARY")


def protected_settings(path: str = PROTECTED_ENV_FILE) -> dict:
    """The overrides in ``path`` (``KEY=value`` lines, only `_PROTECTED_KEYS`);
    a missing or unreadable file is no overrides — the strict defaults."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read(1 << 16)
    except (OSError, ValueError):
        return {}
    out = {}
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key in _PROTECTED_KEYS:
            out[key] = value.strip().strip("'\"")
    return out


def _grants_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".turma", "grants")


def consume_grant(session_id, command, *, grants_dir=None, now=None):
    """The judge's reason when an unexpired grant for exactly this session and
    command exists — consuming it — else None. Never raises on anything the
    filesystem or a planted file can do: it runs inside main()'s fail-CLOSED
    try, where an exception would refuse an ordinary command."""
    if not isinstance(session_id, str) or not GRANT_SID_RE.match(session_id) \
            or session_id in (".", ".."):
        return None
    if not isinstance(command, str) or not command:
        return None
    sdir = os.path.join(grants_dir or _grants_dir(), session_id)
    try:
        if not stat.S_ISDIR(os.lstat(sdir).st_mode):
            return None                 # a symlinked dir is not the judge's
    except (OSError, ValueError):
        return None                     # absent: the common case
    key = grant_key(command)
    path = os.path.join(sdir, key)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
                     | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    except (OSError, ValueError):
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        blob = os.read(fd, GRANT_MAX_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(blob) > GRANT_MAX_BYTES:
        return None
    try:
        data = json.loads(blob.decode("utf-8"))
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or data.get("key") != key or data.get("sid") != session_id:
        return None
    exp = data.get("exp")
    now = time.time() if now is None else now
    if isinstance(exp, bool) or not isinstance(exp, (int, float)) \
            or not now < exp <= now + GRANT_TTL_MAX_SEC:
        return None
    try:
        os.unlink(path)
    except OSError:
        return None                     # another call consumed it first
    reason = data.get("reason")
    reason = " ".join(reason.split()) if isinstance(reason, str) else ""
    return reason[:GRANT_REASON_MAX] or "the operator's permission policy covers it"


# --- hook entrypoint -----------------------------------------------------


def _emit_allow(reason: str) -> None:
    """The only allow a Turma hook emits (XERK-1566): a consumed judge grant.
    It overrides the auto-mode classifier for this one call."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason":
                f"Approved by the operator's permission policy: {reason}",
        }
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _emit_deny(reason: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


# How long the hook may spend before it denies outright. Past Claude Code's hook
# timeout (600s for a command hook, unless its settings entry sets one) the
# command RUNS unchecked, and a session stalls the whole time; real commands
# take well under a second.
_HOOK_DEADLINE_SECONDS = 45
_OVERRUN_REASON = ("refusing a command that took too long to classify (it is too large or too "
                   "convoluted) — split it, or put the data in a file")
# `os._exit`, so a classifier still running cannot hold the process past the
# deadline. A seam for tests, which must not exit the runner.
_hard_exit = os._exit


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    grants_on = GRANTS_FLAG in argv[1:] \
        and os.environ.get("TURMA_PERMISSION_JUDGE", "1") != "0"
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except (ValueError, RecursionError, OSError):  # JSONDecodeError is a ValueError
        # Fail open on a malformed event: a guard that crashes must not wedge
        # the agent. The deny rules in the settings file remain as a backstop.
        return 0
    if not isinstance(event, dict):
        return 0

    tool_name = event.get("tool_name") or ""
    tool_input = event.get("tool_input") or {}
    settings = protected_settings() if PROTECTED_FLAG in argv[1:] else os.environ
    overrides = _parse_overrides(settings.get("TURMA_TOOL_GRANTS"))
    no_attribution = settings.get("TURMA_NO_ATTRIBUTION", "1") != "0"
    pr_summary = settings.get("TURMA_PR_SUMMARY", "1") != "0"
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else None

    verdict: list = []

    def classify() -> None:
        granted = None
        try:
            decision, reason, _category = decide(
                tool_name,
                tool_input if isinstance(tool_input, dict) else {},
                overrides=overrides,
                no_attribution=no_attribution,
                pr_summary=pr_summary,
                cwd=cwd,
            )
            # A judge grant (XERK-1566) is consulted only once decide() ALLOWED the
            # command — every hard deny wins — and only for Bash, the one tool this
            # hook's matcher covers. Inside this fail-closed try on purpose. Only
            # when this session was launched with the judge on (GRANTS_FLAG).
            if grants_on and decision == "allow" and tool_name == "Bash" \
                    and isinstance(tool_input, dict):
                granted = consume_grant(os.environ.get("TURMA_SESSION_ID"),
                                        tool_input.get("command"))
        except Exception as exc:  # noqa: BLE001 - any classifier bug
            # Fail CLOSED here, unlike a malformed event above: a traceback exits 1,
            # which Claude Code treats as non-blocking, so a crash on one segment
            # ran the whole command unclassified (XERK-1080).
            decision = "deny"
            reason = (
                f"the safety guard could not classify this command ({type(exc).__name__}); "
                "refusing it rather than letting it run unchecked. Rephrase it (a grant "
                "cannot help: the crash happens before grants are consulted)."
            )
        verdict.append((decision, reason, granted))

    # Out of time, deny (XERK-1619). The in-decide deadline is checked only
    # between expansions, and one frame — shlex on one huge word is quadratic —
    # overshot it, quadratically, toward the hook timeout, which RUNS the command.
    # A thread, not SIGALRM: this hook also runs on the Windows agent.
    worker = threading.Thread(target=classify, daemon=True)
    worker.start()
    worker.join(_HOOK_DEADLINE_SECONDS)
    if not verdict:
        # Still running is slow; dead without a verdict is a crash past the
        # `except Exception` (SystemExit, KeyboardInterrupt). Both deny.
        _emit_deny(_OVERRUN_REASON if worker.is_alive() else (
            "the safety guard could not classify this command; refusing it rather "
            "than letting it run unchecked."))
        sys.stdout.flush()
        _hard_exit(0)  # the worker cannot be stopped; leaving waits on nothing
        return 0
    decision, reason, granted = verdict[0]
    if decision == "deny" and reason:
        _emit_deny(reason)
    elif decision == "allow" and granted:
        _emit_allow(granted)
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())
