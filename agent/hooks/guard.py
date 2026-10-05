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

import fnmatch
import functools
import hashlib
import json
import os
import posixpath
import re
import shlex
import stat
import sys
import time

# --- command segmentation ------------------------------------------------

# Shell operators that chain separate commands. We inspect each segment so a
# destructive command hidden after `&&`/`;`/`|`/`&`/newline is still caught.
# A single `&` backgrounds the command before it — it separates two commands
# exactly like `;` does, so leaving it out let `sleep 0 & rm -rf /etc` past.
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|&]")

# A leading `FOO=bar` environment assignment on a command.
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")

# Privilege-escalation prefixes we strip before classifying the real command
# (a destructive command is destructive with or without `sudo`).
_PREFIX_WORDS = {
    "sudo", "doas", "runas", "command", "nohup", "time", "exec", "env",
    "timeout", "nice", "ionice", "setsid", "stdbuf", "chrt", "unbuffer", "builtin",
}

# Options of those wrappers that consume the NEXT token as their value, so
# `sudo -u root rm -rf /` strips down to `rm -rf /` rather than stopping at
# `-u` and classifying nothing. Scoped per wrapper: `env -i` takes no value,
# and treating it as if it did swallowed the `rm` that followed.
_PREFIX_OPTS_WITH_VALUE = {
    "sudo": {"-u", "-g", "-p", "-C", "-h", "-R", "-U", "-r", "-t"},
    "doas": {"-u", "-C"},
    "env": {"-u", "--unset", "-C", "--chdir"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "nice": {"-n", "--adjustment"},
    "ionice": {"-c", "-n", "-p"},
    "chrt": {"-p"},
    "stdbuf": {"-i", "-o", "-e"},
    "setsid": set(),
}

# Shell keywords that can lead a segment once `for`/`if`/`while` bodies are
# split on `;` — without these, `do`/`then` becomes the classified program.
_SHELL_KEYWORDS = {
    "do", "done", "then", "else", "elif", "fi", "in", "esac", "!",
    "{", "}", "(", ")", ";;", "if", "while", "until",
}

# Compound-statement heads whose word list runs up to `in` — without skipping
# it, `case x in x) rm -rf /etc;; esac` classified as the program `x`.
_WORDLIST_HEADS = {"for", "case", "select"}

# `f()` in `f() { rm -rf /etc; }`, and `x)` in a case arm. Both lead a segment
# whose real command follows them.
_FUNC_DEF_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\(\)$")
_CASE_PATTERN_RE = re.compile(r"^[^()\s]+\)$")

# Interpreters whose `-c <string>` argument is a whole command line of its own.
_SHELL_PROGS = {"bash", "sh", "zsh", "ksh", "dash", "ash", "busybox", "su"}

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
_CMD_KEYWORDS = {"then", "do", "else", "elif", "if", "while", "until", "time", "!", "{"}
_CASE_PATTERN_OPEN_RE = re.compile(r"(?:\bin|;;&?|;&)\s*$")


def _word_before(command: str, j: int) -> tuple[str, int]:
    """The word ending at index ``j`` (inclusive) and the index it starts at."""
    k = j
    while k >= 0 and command[k] not in _WORD_END:
        k -= 1
    return command[k + 1:j + 1], k + 1


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


def _is_comment(command: str, i: int) -> bool:
    """`#` starts a comment only at the start of an UNESCAPED word."""
    if i == 0:
        return True
    prev = command[i - 1]
    # Not after `)`: `$(x)#…`, `<(x)#…` and `$((1))#…` CONTINUE the word, so
    # bash runs what follows. After a subshell's `)` it would be a comment;
    # reading it as text there can only classify more.
    if prev in ";&|(":
        return True
    # `a\ #` is one word, `a\<newline>#` is `a#`: an escaped blank is no break.
    return prev in " \t\n" and not (i >= 2 and command[i - 2] == "\\")


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
        if ch == "#" and _is_comment(command, i):
            end = command.find("\n", i)
            i = n if end < 0 else end
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


def _quote_states(command: str) -> list[str]:
    """How each character of ``command`` is quoted: `'` inside a single-quoted
    literal, `"` inside a double-quoted string, `\\` escaped, "" bare.

    A `$(…)` inside a string restarts quoting, as bash does, so the `'…'` in
    `"$(echo 'a')"` is a real single-quoted literal again. A `#` comment is
    `#` to its line's end: the apostrophe in `# don't` opened a "quote" that
    every later character was read inside (XERK-1549).
    """
    out = [""] * len(command)
    stack: list[str] = []
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        top = stack[-1] if stack else ""
        if ch == "#" and top != '"' and _is_comment(command, i):
            end = command.find("\n", i)
            end = n if end < 0 else end
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
        if top == '"':
            out[i] = '"'
            if ch == '"':
                stack.pop()
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
        elif ch == "(":
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
    and the like print just the same."""
    return _printed_from_tokens(_strip_prefixes(_tokenize(command)))


def _printed_from_tokens(toks: list[str]) -> str | None:
    """`_printed_text` from an already-tokenised argv, so a caller can strip a
    prefix (`sudo echo …`) without re-joining and corrupting printf's words."""
    if not toks:
        return None
    prog = _basename(toks[0])
    if prog == "printf":
        name, rest = _printf_args(toks)
        return _render_printf(rest[0], rest[1:]) if name is None and rest else ""
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


@functools.lru_cache(maxsize=1024)
def _body_printed(body: str, raw: bool) -> tuple[str | None, int]:
    """`_printed_text` of a substitution body once its own substitutions are
    resolved, and the escaped ones that skipped (replayed by the caller, as
    `_memo` does). Memoised: every pass over a line re-resolves each nesting
    level beneath it, which on thousands of levels runs past the hook timeout,
    which fails OPEN. ``raw`` is `_SPLICE_RAW`, which the resolution reads."""
    before = _SPLICES_ESCAPED[0]
    printed = _printed_text(_unwrap_group(_sub_substs(body, _subst_text)))
    return printed, _SPLICES_ESCAPED[0] - before


def _subst_text(m: "re.Match[str]", glued_empty: bool = False) -> str:
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
    """
    # The body's own substitutions run first, and a subshell prints what its
    # body prints: `` `echo \\`echo …\\`` `` and `$( (echo …) )` print the
    # inner text (XERK-1605).
    if _SUBST_DEPTH[0] >= _MAX_SUBST_DEPTH:
        return _OPAQUE_SUBST
    _SUBST_DEPTH[0] += 1
    try:
        printed, escaped = _body_printed(_subst_inner(m), _SPLICE_RAW[0])
    finally:
        _SUBST_DEPTH[0] -= 1
    _SPLICES_ESCAPED[0] += escaped
    if printed is not None:
        return printed
    if glued_empty and not _subst_standalone(m):
        return ""
    return _OPAQUE_SUBST



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
    """The outermost `$(…)`, `<(…)`, `>(…)` and backtick substitutions in
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
    """
    n = len(text)
    close_paren: dict[int, int] = {}
    parens: list[int] = []
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
        elif ch == ")" and parens:
            close_paren[parens.pop()] = i
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
        _budget = {"left": _MAX_SUBST_GROWTH, "expand": {}, "vals": {}}
        try:
            return fn(*args, **kwargs)
        finally:
            _budget = None

    return run


def _memo(kind: str, key, fn, *args):
    """``fn(*args)``, made once per decision. A hit replays the escaping
    splices it counted, which is what makes `_expand_both` take its raw pass."""
    memo = _budget[kind]
    key = (key, _SPLICE_RAW[0])
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
_ANSI_C_RE = re.compile(r"\$'((?:[^'\\]|\\.)*)'")
# A `{…}` word; it expands only when a `,` follows its first character. Testing
# that in the regex (`[^{}\s]+,[^{}\s]*`) backtracked over every comma of an
# unclosed `{a,a,…`: quadratic, and a hook that times out runs the command
# (XERK-1596).
_BRACE_RE = re.compile(r"\{([^{}\s]+)\}")
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
_VAR_ASSIGN_RE = re.compile(
    # A lookbehind, not a consumed lead-in plus `\s*`: that re-scanned a
    # whitespace run from each of its blanks, quadratic in its length (XERK-1601).
    r"(?<![^;\n&|\s])"
    r"([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]\s]*\])?\+?="
    r"(\([^()]*\)|(?:" + _ASSIGN_SUBST + r"|'[^']*'|\"(?:[^\"\\]|\\.)*\"|[^\s;|&\n'\"`])*)"
)
# printf's conversions — flags, `*`/digit width, `.`/`.*`/digit precision —
# and the backslash escapes it decodes in a format (and in a `%b` argument).
_PRINTF_SPEC_RE = re.compile(r"%(%|[-+ #0']*(\*|\d+)?(?:\.(\*|\d*))?[hlLqjzt]*([a-zA-Z]))")
_PRINTF_ESC_RE = re.compile(r"\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|0?[0-7]{1,3}|.)", re.S)
# `\c` ends printf's output, there and then.
_PRINTF_STOP = "\x00turma-printf-stop"
_PRINTF_MAX_WIDTH = 256
_PRINTF_ESCAPES = {"c": _PRINTF_STOP, "n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b",
                   "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"'}
_FOR_IN_RE = re.compile(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+)")
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


def _var_uses(text: str):
    """``_VAR_USE_RE.finditer(text)``, in time linear in ``text``."""
    k = text.rfind("}") + 1
    yield from _VAR_USE_RE.finditer(text, 0, k)
    yield from _VAR_BARE_RE.finditer(text, k)


def _var_sub(repl, text: str) -> str:
    """``_VAR_USE_RE.sub(repl, text)``, in time linear in ``text``."""
    out, last = [], 0
    for m in _var_uses(text):
        out += (text[last:m.start()], repl(m))
        last = m.end()
    out.append(text[last:])
    return "".join(out)

# The expansion operators, longest spelling first so `##` never matches as `#`.
_VAR_OP_RE = re.compile(r"^(##|#|%%|%|:-|:=|:\+|-|=|\+|//|/|:)(.*)$", re.DOTALL)

# The operators that supply a literal when the name is UNSET. These need no
# assignment anywhere, so `rm -rf ${nope:-/etc}` names /etc outright.
_VAR_DEFAULT_OPS = {":-", "-", ":=", "="}


def _apply_var_op(value: str, op: str, arg: str) -> str:
    """Apply a `${name<op><arg>}` expansion to a known value.

    Only the literal cases are modelled — enough that a one-character operator
    cannot walk around a path rule (`${d%/}` was exactly that). A pattern we
    cannot evaluate leaves the value alone rather than guessing.
    """
    arg = arg.strip("'\"")
    if op in ("#", "##"):
        pat = arg.replace("*", "")
        return value[len(pat):] if pat and value.startswith(pat) else value
    if op in ("%", "%%"):
        pat = arg.replace("*", "")
        return value[: -len(pat)] if pat and value.endswith(pat) else value
    if op in ("/", "//"):
        pat, _, rep = arg.partition("/")
        return value.replace(pat, rep, -1 if op == "//" else 1) if pat else value
    if op == ":":
        bits = arg.split(":")
        try:
            start = int(bits[0])
            return value[start: start + int(bits[1])] if len(bits) > 1 else value[start:]
        except (ValueError, IndexError):
            return value
    return value


def _decode_ansi_c(command: str) -> str:
    """`$'\\x2fetc'` → `/etc`, re-quoted so it stays one token."""

    def rep(m: "re.Match[str]") -> str:
        try:
            return shlex.quote(m.group(1).encode().decode("unicode_escape"))
        except (UnicodeDecodeError, UnicodeEncodeError):
            return m.group(0)

    return _ANSI_C_RE.sub(rep, command)


def _expand_braces(command: str) -> str:
    """`rm -rf {/etc,/var}` → `rm -rf /etc /var` (prefix/suffix preserved).

    A QUOTED brace is text — bash expands none inside `'…'` or `"…"`, and
    rewriting `awk '{print $2,$4}'` unbalanced its quotes (XERK-1256). A quoted
    script handed to `bash -c`/`eval` is re-expanded unquoted where it runs.
    """
    pos = 0
    expansions = 0
    states = _quote_states(command)
    while expansions < 4:  # bounded: an expansion can re-create a brace
        m = _BRACE_RE.search(command, pos)
        if not m:
            break
        start, end = m.span()
        if states[start] or "," not in m.group(1)[1:]:
            pos = start + 1
            continue
        expansions += 1
        word_start = command.rfind(" ", 0, start) + 1
        word_end = command.find(" ", end)
        if word_end == -1:
            word_end = len(command)
        prefix, suffix = command[word_start:start], command[end:word_end]
        parts = [prefix + p.strip() + suffix for p in m.group(1).split(",")]
        command = command[:word_start] + " ".join(parts) + command[word_end:]
        pos = word_start
        states = _quote_states(command)
    return command


@_budgeted
def _var_values(command: str) -> dict[str, list[str]]:
    """Values this command line itself assigns to a variable."""
    return _memo("vals", command, _assigned_values, command)


def _assigned_values(command: str) -> dict[str, list[str]]:
    vals: dict[str, list[str]] = {}
    for m in _VAR_ASSIGN_RE.finditer(command):
        value = m.group(2)
        if value.startswith("(") and value.endswith(")"):
            # An array, `a=(rm -rf *)`: its words, which `"${a[@]}"` runs.
            value = value[1:-1].strip()
        vals.setdefault(m.group(1), []).append(_produced_text(_dequote_value(value)))
    for m in _FOR_IN_RE.finditer(command):
        words = [w for w in m.group(2).split() if w != "do"]
        if words:
            vals.setdefault(m.group(1), []).extend(words)
    if "printf" in command and "-v" in command:
        for seg in _split_segments(command):
            bound = _printf_v(_strip_prefixes(_tokenize(seg)))
            if bound:
                vals.setdefault(bound[0], []).append(bound[1])
    # A value naming an assigned variable (`d=$d/x`, `a=$b; b=$a`) is resolved
    # HERE, once, against the values that name none. Left in, every recursion
    # level re-inlined it, the text grew each time, and an ordinary command
    # was refused as nested too deeply. An unresolvable one is empty, as bash
    # reads an unset name.
    plain = {k: [v for v in vs if not _names_assigned(v, vals)] for k, vs in vals.items()}

    def resolve(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(3) or ""
        if name not in vals:
            return m.group(0)
        value = " ".join(plain[name])
        _spend(len(value) - len(m.group(0)))
        return value

    return {k: [_var_sub(resolve, v) for v in vs] for k, vs in vals.items()}


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
                if value[j] == "\\" and j + 1 < n:
                    j += 1
                out.append(value[j])
                j += 1
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _produced_text(value: str) -> str:
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
        out.append(_subst_text(m))
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


def _names_assigned(value: str, vals: dict[str, list[str]]) -> bool:
    return any((m.group(1) or m.group(3)) in vals for m in _var_uses(value))


@functools.lru_cache(maxsize=16)
def _closers(command: str) -> dict[int, int]:
    """Per command line: where each opener `_brace_end` has scanned closes."""
    return {}


def _brace_end(command: str, i: int) -> int:
    """Index of the `}` closing the `${` at ``i``, or -1 if it never closes.

    Quotes, `$(…)`, backticks and nested `${…}` inside the braces hide a `}`,
    as they do from bash: `${a:-'}'}` and `${a:-$(echo })}` are one expansion.

    Where an opener closes depends only on the text after it, so every opener
    the scan passes is remembered per command line and skipped on the next
    scan. Without that, each of N unclosed `${a:-$(` ran to the end of the
    line: O(N × length), minutes for a 40 KB command, and a hook that times
    out lets the command run unchecked (XERK-1596).
    """
    memo = _closers(command)
    if i in memo:
        return memo[i]
    stack = [("{", i)]
    j, n = i + 2, len(command)

    def opened(kind: str) -> int:
        """Push the opener at ``j``; a remembered one is skipped instead.
        Returns where the scan resumes, or -1 once the outer one can't close."""
        end = memo.get(j)
        if end is None:
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
        elif (ch == "}" and top == "{") or (ch == ")" and top == "("):
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


@_budgeted
def _substitute_vars(command: str, vals: dict[str, list[str]] | None = None) -> str:
    """Inline variables the command line sets itself.

    Only names this very command assigns are substituted — an unresolved
    `$TMPDIR` is left alone rather than guessed at. ``vals`` supplies them
    from an enclosing command line instead (a group body sees its parent's).
    """
    # NB: no early return on an empty map — `${nope:-/etc}` needs no assignment.
    if vals is None:
        vals = _var_values(command)

    states = _quote_states(command) if vals and "$" in command else []

    def rep(m: "re.Match[str]") -> str:
        if not _SPLICE_RAW[0] and not _live_dollar(command, m.start()):
            # `\${a:-\"}` is literal text to bash, and `$${` is the PID then a
            # brace. Splicing either's "default" shifted the quoting under the
            # rest of the line: `echo "\${a:-\"}"; rm -rf /` hid the `rm`
            # inside a string that had closed (XERK-1585). Which `$` is live is
            # right for ONE parse only — an unquoted heredoc or `bash -c "…"`
            # strips a backslash level first — so `_expand_both` also takes the
            # splice-everything reading.
            _SPLICES_ESCAPED[0] += 1
            return m.group(0)
        if m.group(1) and _brace_end(command, m.start()) != m.end() - 1:
            # `[^}]*` stopped at a `}` that is quoted or nested — in
            # `${a:-'}' #}` the expansion runs on to the last `}`. Splicing the
            # short match left the `#` bare, a comment hiding the rest of the
            # line (XERK-1585); the raw text is read as one word instead.
            return m.group(0)
        name = m.group(1) or m.group(3) or ""
        got = vals.get(name)
        op = _VAR_OP_RE.match(m.group(2) or "")
        if got:
            value = got[0] if len(got) == 1 else " ".join(got)
            state = states[m.start()] if m.start() < len(states) else ""
            if state == '"' and (m.group(2) or "").startswith(("[@]", "[*]")):
                # `"${a[@]}"` is one word PER element, even mid-word: close
                # the quote around them, as bash's expansion does.
                out = '"' + _quote_literal(value, "") + '"'
            else:
                if op:
                    value = _apply_var_op(value, op.group(1), op.group(2))
                out = _quote_literal(value, state)
        elif op and op.group(1) in _VAR_DEFAULT_OPS:
            # Spliced bare, `${y:- #}; rm -rf /` became `echo  #; rm -rf /` and
            # the `rm` a comment. The `#` was a word inside the braces; keep it
            # one (XERK-1585). Quotes and `$(…)` in the default stay live.
            out = re.sub(r"(?<!\\)#", r"\\#", op.group(2))
        else:
            return m.group(0)
        _spend(len(out) - len(m.group(0)))
        return out

    return _var_sub(rep, command)


# Set while `_expand_both` takes its raw reading; counts escaping splices.
_SPLICE_RAW = [False]
_SPLICES_ESCAPED = [0]


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


def _prenormalise(command: str) -> str:
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


def _split_heredocs(command: str) -> tuple[str, list[tuple[str, str, bool]]]:
    """Split ``command`` into (commands-only text, [(owner line, body, quoted)]).

    A lexer, not a per-line regex (XERK-1256): a regex found `<<` wherever it
    sat, so the here-string `cat <<<x`, a quoted `echo '<<x'` and a comment
    `# <<x` each opened a "heredoc" that swallowed every following line up to
    one reading `x` — commands bash runs, never classified. Only an operator
    outside quotes and comments opens one, and arithmetic `$((1<<2))` is a
    shift. ``quoted`` is whether the delimiter was, i.e. whether bash leaves
    the body literal or expands `$(…)` and backticks inside it.
    """
    kept: list[str] = []
    bodies: list[tuple[str, str, bool]] = []
    pending: list[tuple[str, bool, bool]] = []  # (delimiter, quoted, strip tabs)
    # '"' a double-quoted string, '(' a `$(…)`/`(…)` group (quoting restarts in
    # one, even inside a string), 'p' a `${…}`.
    stack: list[str] = []
    line_start = 0  # index into ``kept`` of the current line's first piece
    i, n = 0, len(command)
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
        elif ch == "#" and top != "p" and _is_comment(command, i):
            end = command.find("\n", i)
            end = n if end < 0 else end
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
            kept.append(command[i:end])
            i = end
            continue
        elif ch == "\n" and pending:
            # Bodies start after the line the operators sit on, in order.
            owner = "".join(kept[line_start:])
            kept.append("\n")
            i += 1
            for delim, quoted, strip_tabs in pending:
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
            pending = []
            line_start = len(kept)
            continue
        if ch == "\n":
            line_start = len(kept) + 1
        kept.append(ch)
        i += 1
    return "".join(kept), bodies


def _split_on_operators(command: str, include_pipe: bool = True) -> list[str]:
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
    i, n = 0, len(command)

    # How many leading chunks of `buf` are known blank: `buf` only grows
    # between resets, so this scans each chunk once. Re-joining `buf` per
    # character made a long blank pattern quadratic (XERK-1601).
    blank_n = 0

    twin = ""

    def flush() -> None:
        nonlocal buf, blank_n, twin
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
        if command.startswith(("$$", "${", "$("), i) and (braces or command[i + 1] in "{$"):
            # `$$` is the PID, so `$${` opens nothing.
            if command[i + 1] != "$":
                braces.append(command[i + 1])
            buf.append(command[i:i + 2])
            i += 2
            continue
        if braces and ch == "}" and braces[-1] == "{":
            braces.pop()
        elif braces and ch == ")" and braces[-1] == "(":
            braces.pop()
        elif ch == "#" and not braces and _is_comment(command, i):
            end = command.find("\n", i)
            i = n if end < 0 else end
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
        if command[i:i + 2] in ("&&", "||"):
            flush()
            i += 2
            continue
        if ch in (";", "\n", "&") or (include_pipe and ch == "|"):
            # The `&` of `2>&1` and the `|` of `>|f` may belong to a
            # redirection, which splitting cuts: `>/dev/null 2>&1 rm -rf /etc`
            # became `… 2>` and `1 rm -rf /etc`. Whether it does, the text
            # cannot say — `\>&` and an expansion that printed `>` leave a real
            # operator — so read the next segment BOTH ways: as split, and with
            # the redirection rebuilt (`>&1 rm -rf /etc`) (XERK-1616).
            redirected = ch in "&|" and bool(buf) and buf[-1].endswith(("<", ">"))
            flush()
            if redirected:
                twin = ">" + ch
            i += 1
            continue
        buf.append(ch)
        i += 1
    flush()
    return [seg.strip() for seg in out if seg.strip()]


def _split_segments(command: str) -> list[str]:
    return _split_on_operators(command, include_pipe=True)


def _unwrap_group(segment: str) -> str:
    """Strip subshell/group wrappers so `(rm -rf /)` classifies as `rm -rf /`."""
    seg = segment.strip()
    while len(seg) >= 2 and (
        (seg[0] == "(" and seg[-1] == ")") or (seg[0] == "{" and seg[-1] == "}")
    ):
        seg = seg[1:-1].strip().rstrip(";").strip()
    return seg


@functools.lru_cache(maxsize=512)
def _tokenize_cached(segment: str) -> tuple[str, ...]:
    try:
        return tuple(shlex.split(segment, posix=True))
    except ValueError:
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
            while out and out[0].startswith("-") and len(out[0]) > 1:
                opt = out.pop(0)
                split = _env_split_string(opt, out) if wrapper == "env" else None
                if split is not None:
                    # `env -S "sh -c 'rm -rf /'"` runs its operand as a command
                    # LINE, which classified as one unknown program (XERK-1539).
                    out[:0] = _tokenize(split)
                    continue
                if "=" not in opt and opt in takes_value and out:
                    out.pop(0)
            # `timeout 5s cmd` / `nice 10 cmd`: a bare duration/priority operand.
            if wrapper in ("timeout", "nice") and out and re.match(r"^[0-9]", out[0]):
                out.pop(0)
            continue
        break
    return out


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
_STDIN_SCRIPT_RE = re.compile(r"^(?:-|/dev/stdin|/dev/fd/\d+|/proc/(?:self|\d+)/fd/\d+)$")
# Shell options that consume the NEXT token, so it is not taken as the script.
_SHELL_OPTS_WITH_VALUE = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# A redirection word: `2>&1`, `>/dev/null`, `<`, `<<<`. Its target follows
# when the operator stands alone.
_REDIRECT_RE = re.compile(r"^\d*(?:<<<|<<-?|<>|<&|>&|&>>?|>[|>]?|<)(.*)$", re.S)


def _proc_subst_path(m: "re.Match[str]") -> str:
    """`<(…)` reads as the fd path bash hands the command; anything else as
    the text it contributes."""
    return "/dev/fd/63" if m.group(0).startswith("<(") else _subst_text(m)


def _reads_stdin_script(stage: str) -> bool:
    """Whether the command in ``stage`` runs its stdin (or an inherited fd) as
    a SCRIPT: a shell with no `-c` and no script file (`… | sh`, `bash -s`,
    `sh <<< '…'`), or `source`/`.` of such a path (`. <(echo …)`)."""
    tokens = _strip_prefixes(_tokenize(_sub_substs(stage, _proc_subst_path)))
    # `sh<<<'…'` tokenises as one word; the program is the part before it.
    if tokens and "<" in tokens[0] and not tokens[0].startswith("<"):
        head, _, tail = tokens[0].partition("<")
        tokens = [head, "<" + tail, *tokens[1:]]
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
    if prog not in _SHELL_PROGS or _shell_c_index(rest) >= 0:
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


# xargs options that consume the NEXT token as their value.
#
# `-i` and `-e` are deliberately NOT here, and neither are `--replace`/`--eof`:
# their values are OPTIONAL and must be ATTACHED (`-i{}`, `--replace={}`), so
# `xargs -i rm -rf {}` passes `rm` as the COMMAND. Listing them ate the `rm` and
# reopened the very bypass the `-I` fix closed.
_XARGS_OPTS_WITH_VALUE = {
    "-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a",
    "--max-args", "--max-lines", "--max-procs", "--max-chars",
    "--delimiter", "--arg-file",
}


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


def _find_roots(tokens: list[str]) -> list[str]:
    """The paths a `find` invocation walks (its operands before any predicate)."""
    roots = []
    for tok in tokens[1:]:
        if tok.startswith("-") or tok in ("(", ")", "!"):
            break
        roots.append(tok)
    return roots


def _expand_both(command: str) -> list[tuple[list[str], str]]:
    """`_expand_segments`, and — when a spliced value needed escaping, or an
    expansion was read as escaped — again with every value spliced raw and
    every expansion live (see `_quote_literal`, `_live_dollar`). Neither
    reading is right at every re-parse depth; together they fail closed."""
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
    """``script`` as a word shlex produced, and again with `\\${` unescaped.
    Inside `"…"` bash drops that backslash and shlex keeps it, so
    `bash -c "echo \\${a:-'}' #}; rm -rf /"` reached the re-parse with an
    escaped `$` and its `#` read as a comment (XERK-1585). The token no longer
    says which quoting it came from; reading both fails closed. Only `${`: an
    escaped `$(` or backtick is already classified where it sits, and
    unescaping those too nested real scripts past _MAX_EXPAND_DEPTH."""
    plain = script.replace("\\${", "${")
    return [script] if plain == script else [script, plain]


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
    # Groups first, over the whole command: splitting below would sever any
    # group whose body holds an operator (see _balanced_groups). Scanned
    # BEFORE pre-normalisation, whose brace expansion ignores quoting and can
    # unbalance them (`awk '{print $2, $4}'`); each body gets the variables
    # this line assigns, so `d=/etc; (true; rm -rf $d)` still resolves.
    raw_commands, heredocs = _split_heredocs(command)
    raw_vals = _var_values(raw_commands)
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
    every_cd = _cd_targets(_sub_substs(_prenormalise(raw_commands), _subst_text), cwds)
    if every_cd != cwds and _REPLAYS_RE.search(command):
        cwds = every_cd
    bodies, suspect = _balanced_groups(raw_commands)
    # Every heredoc on one line shares that whole line as its owner, so the
    # pipes-into-a-shell scan below is memoised on the owner string — re-running
    # it per heredoc was O(heredocs × stages) and hung a 2000-heredoc line.
    owner_pipes_to_shell: dict[str, bool] = {}
    for owner, body, quoted in heredocs:
        # A heredoc fed to a SHELL is a script, not data — `bash <<EOF ... EOF`
        # runs every line of it. Expand those bodies as commands; bodies fed to
        # anything else stay data (see _destructive_database for the psql case).
        owner_tokens = _strip_prefixes(_tokenize(_SUBST_RE.sub(" ", owner)))
        def _owner_feeds_shell() -> bool:
            # So is one an owner that PIPES into a shell: `cat <<'EOF' | bash`
            # (XERK-1539). Memoised on the owner string (every heredoc on a line
            # shares it) and reached only when the cheap head check below misses,
            # so a `bash <<EOF` owner never pays for this scan.
            if owner not in owner_pipes_to_shell:
                owner_pipes_to_shell[owner] = any(
                    _reads_stdin_script(st) for st in _split_segments(owner)[1:])
            return owner_pipes_to_shell[owner]
        if (owner_tokens and _basename(owner_tokens[0]) in (_SHELL_PROGS | {"eval", "source", "."})
                or _owner_feeds_shell()):
            out.extend(_expand_segments(_substitute_vars(body, raw_vals), depth + 1, every_cd))
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
        before = cwds
        if every_cd != cwds:
            # The `cd`s written before the group are the ones it runs after.
            head = raw_commands[:max(raw_commands.find(body), 0)]
            before = _cd_targets(_sub_substs(_prenormalise(head), _subst_text), cwds)
        body = _substitute_vars(body, raw_vals)
        expanded.add((body, before))
        out.extend(_expand_segments(body, depth + 1, before))
    command = _prenormalise(raw_commands)
    segments = _split_segments(command)
    # `xargs` takes its operands from the PIPE, not its own argv, so
    # `echo /etc | xargs rm -rf` carries the target in a sibling segment.
    # Collect every path-shaped operand in the command so an xargs segment can
    # be judged against what is actually going to be fed to it.
    piped_operands: list[str] = []
    for raw in segments:
        for tok in _tokenize(raw):
            if not tok.startswith("-") and ("/" in tok or tok in ("~", ".", "..")):
                piped_operands.append(tok)
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
    feeds_a_shell = "|" in command or "<<<" in command or "<(" in command
    for pipeline in _split_on_operators(command, include_pipe=False) if feeds_a_shell else ():
        # A single-stage "pipeline" with no here-string or `<(…)` has nothing
        # feeding it either, so skip its per-stage scan too.
        if "|" not in pipeline and "<<<" not in pipeline and "<(" not in pipeline:
            continue
        producers: list[str] = []       # distinct printed/here-string texts so far
        seen_texts: set[str] = set()
        def _feed(text: str) -> None:
            if text and text.strip() and text not in seen_texts \
                    and len(seen_texts) < _FED_TEXT_CAP:
                seen_texts.add(text)
                producers.append(text)
        for stage in _split_segments(pipeline):
            ustage = _unwrap_group(stage)
            if _reads_stdin_script(ustage):
                fed = list(producers)
                fed.extend(_herestrings(ustage))
                for m in _find_substs(ustage):
                    if m.group(0).startswith("<("):
                        printed = _body_printed(_subst_inner(m), _SPLICE_RAW[0])[0]
                        if printed:
                            fed.append(printed)
                for text in fed:
                    if text.strip():
                        out.extend(_expand_segments(text, depth + 1, every_cd))
            # This stage's own contribution to readers DOWNSTREAM of it. A
            # producer behind a prefix (`sudo echo …`, `time printf …`) still
            # prints, so strip them before reading what it emits.
            for seg in _split_segments(ustage):
                seg = _unwrap_group(seg)
                _feed(_printed_from_tokens(_strip_prefixes(_tokenize(seg))) or "")
                # ...and with its substitutions run: tokenising first split a
                # nested backtick at its escaped inner opener (XERK-1605).
                _feed(_printed_text(_sub_substs(seg, _subst_text)) or "")
                for hs in _herestrings(seg):
                    _feed(hs)
    for raw in segments:
        if every_cd != cwds:
            cwds = _cd_targets(_sub_substs(raw, _subst_text), cwds)
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
        # An `eval`'s words joined as eval re-parses them, read off the RAW
        # segment (XERK-1585). The substitution pass above swallowed a QUOTED
        # `'$('` that the join makes live (`eval echo '$(' rm -rf / ')'`), and
        # collapsing `eval eval …` (below) skipped a parse: the `\\\;` in
        # `eval eval echo \\\; rm -rf /` is an operator only to the SECOND
        # eval, which this reaches by recursing once per eval (bounded by
        # _MAX_EXPAND_DEPTH, which fails closed).
        words = _strip_prefixes(_tokenize(_unwrap_group(raw)))
        if len(words) > 1 and _basename(words[0]) == "eval":
            for script in _script_readings(" ".join(words[1:])):
                out.extend(_expand_segments(script, depth + 1, every_cd))
        if seg != raw.strip() and seg:
            # A group/substitution-stripped body can itself hold operators.
            if _SEGMENT_SPLIT.search(seg):
                out.extend(_expand_segments(seg, depth + 1, cwds))
                continue
        tokens = _strip_prefixes(_tokenize(seg))
        if not tokens:
            continue
        out.append((tokens, seg))
        prog = _basename(tokens[0])
        rest = tokens[1:]
        if prog in ("rm", "unlink", "chmod", "chown"):
            # `cd /; rm -rf *` deletes `/*`, which `rm` alone never names.
            for cwd in cwds:
                joined = [_under_cwd(t, cwd) for t in rest]
                if joined != rest:
                    out.append(([tokens[0], *joined], seg, False, cwd))
        if prog in _SHELL_PROGS:
            i = _shell_c_index(rest)
            if i >= 0 and i + 1 < len(rest):
                for script in _script_readings(rest[i + 1]):
                    out.extend(_expand_segments(script, depth + 1, every_cd))
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
            inner = list(rest)
            while inner and inner[0].startswith("-"):
                opt = inner.pop(0)
                if "=" not in opt and opt in _XARGS_OPTS_WITH_VALUE and inner:
                    inner.pop(0)
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
                argv = _strip_prefixes(expanded + piped_operands)
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
                # Equivalent to a recursive delete of everything it walks.
                out.append((["rm", "-r", *roots], seg))
                for cwd, joined in by_cwd:
                    out.append((["rm", "-r", *joined], seg, False, cwd))
            roots += [r for _, joined in by_cwd for r in joined]
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
                    run = []
                    for tok in rest[i + 1:ends[i]]:
                        # `{}` stands for each path found — i.e. the roots.
                        if tok == "{}":
                            _spend(roots_chars)
                        run.extend(roots if tok == "{}" else [tok])
                    if run:
                        # Every run is classified with the whole segment, and
                        # checkers rescan that text per entry: 5000 runs took
                        # 30s (XERK-1589), so each run charges the segment.
                        _spend(len(seg))
                        argv = _strip_prefixes(run)
                        out.append((argv, seg))
                        # `find . -exec sh -c '<cmd>' \;` (XERK-1539).
                        out.extend(_expand_segments(
                            " ".join(shlex.quote(t) for t in argv), depth + 1, cwds))
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



def _cd_targets(text: str, inherited: tuple[str, ...]) -> tuple[str, ...]:
    """``inherited`` plus each absolute or home directory a `cd` in ``text``
    names. A relative or unknowable one (`cd -`, `cd $OLDPWD`) adds nothing:
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
        target = _norm_path(ops[0]) if ops else "~"  # a bare `cd` goes home
        low = target.lower()
        if low.startswith("/") or low.rstrip("/") in _HOME_TOKENS or _HOME_USER_RE.match(low):
            target = target.rstrip("/") or "/"
            if target not in found:
                found.append(target)
        if len(found) >= _MAX_CWDS:
            break
    return tuple(found)


def _is_exact_root(path: str) -> bool:
    low = path.lower()
    return low in _HOME_TOKENS or low in _SYSTEM_ROOTS or bool(_HOME_USER_RE.match(low))


def _under_cwd(tok: str, cwd: str) -> str:
    """An `rm` operand read from inside ``cwd``. Inside an exact protected root
    every relative operand is joined (`cd /etc; rm -rf ./*` is `/etc/*`).
    Deeper, only one climbing out with `..` is (`cd /tmp; rm -rf ../*` is
    `/*`): joining the rest would refuse `cd /usr/src/app && rm -rf build`,
    which names nothing an absolute rm would not, for a cwd that may be stale."""
    if tok.startswith(("-", "/", "~", "$", _OPAQUE_SUBST)):
        return tok
    if _is_exact_root(cwd) or ".." in tok.split("/"):
        return cwd.rstrip("/") + "/" + tok
    return tok


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
        if fnmatch.fnmatch(bare, pattern) or fnmatch.fnmatch(bare + "/", pattern):
            return True
    return False


def _is_dangerous_path(tok: str) -> bool:
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
    if (_GLOB_CHARS.search(leaf) and (parent in _HOME_TOKENS or _HOME_USER_RE.match(parent))
            and fnmatch.fnmatch(".ssh", leaf)):
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


def _is_home_ssh(tok: str) -> bool:
    """`~/.ssh` itself — deleting it loses the keys, though `chmod -R 700` of
    it is the routine permission fix, so only `rm` asks this."""
    parent, _, leaf = _norm_path(tok).lower().rstrip("/").rpartition("/")
    return leaf == ".ssh" and (parent in _HOME_TOKENS or bool(_HOME_USER_RE.match(parent)))


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
    for tgt in targets:
        if _is_dangerous_path(tgt) or _is_home_ssh(tgt):
            return f"refusing recursive delete of a protected path ({tgt!r})"
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
        if _is_dangerous_path(tok):
            return f"refusing recursive {prog} on a protected path ({tok!r})"
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
    for tokens, segment, *_flags in _expand_both(command):
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
        i = _shell_c_index(tokens[1:])
        if i >= 0 and i + 1 < len(tokens[1:]):
            return _stage_executes_sql(_tokenize(tokens[1:][i + 1]), depth + 1)
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
    if _budget["left"] < 0:
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
    if _budget["left"] < 0:
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
    overrides = _parse_overrides(os.environ.get("TURMA_TOOL_GRANTS"))
    no_attribution = os.environ.get("TURMA_NO_ATTRIBUTION", "1") != "0"
    pr_summary = os.environ.get("TURMA_PR_SUMMARY", "1") != "0"
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else None

    try:
        decision, reason, _category = decide(
            tool_name,
            tool_input if isinstance(tool_input, dict) else {},
            overrides=overrides,
            no_attribution=no_attribution,
            pr_summary=pr_summary,
            cwd=cwd,
        )
        granted = None
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
    if decision == "deny" and reason:
        _emit_deny(reason)
    elif decision == "allow" and granted:
        _emit_allow(granted)
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())
