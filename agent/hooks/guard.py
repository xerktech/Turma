#!/usr/bin/env python3
"""Turma agent safety guard — a Claude Code ``PreToolUse`` hook.

Sessions run the agent hands-off (``--permission-mode auto`` by default, or
``bypassPermissions`` when an operator picks it) so it can do whatever a task
needs (read, write, run builds/tests, git, network) with little or **no**
per-tool approval round-trip. This hook is the backstop that makes that safe: it
inspects every Bash tool call *before* it runs and blocks only three narrow
categories.

1. **destructive** — commands that would wreck the whole repository or the host
   machine: ``rm -rf`` of ``/``/home/system paths or ``.git``, disk wipes
   (``mkfs``/``dd of=/dev/...``/``format``), fork bombs, host power-state
   changes, recursive ``chmod``/``chown`` of system roots, git history
   destruction (``branch -D main``, ``filter-branch``, reflog-expire,
   ``reset --hard`` onto a protected branch), and database drops
   (``DROP DATABASE``/``TABLE``). Denied with a reason the model self-corrects
   from. A specific destructive command an operator wants to permit can be
   allowlisted via ``$TURMA_TOOL_GRANTS`` (a CSV of ``Bash(<command>)``
   patterns) — the exact command only, never a blanket grant.

2. **policy** — PR-workflow rules, enforced hard (no override): pushing to or
   deleting ``main``/``master`` directly, and merging any pull/merge request
   (``gh pr merge``, ``glab mr merge``, completing or auto-completing an Azure
   DevOps PR). Work lands via a PR/MR the agent opens but never self-merges.
   Denied with a reason the agent self-corrects from.

3. **attribution** — ``git commit`` / PR commands carrying AI self-attribution
   (``Co-Authored-By: ... Claude``/``Anthropic``, ``Generated with Claude``,
   the robot emoji, ``noreply@anthropic.com``). Denied with a reason so the
   agent rewrites the message and continues. Disable with
   ``$TURMA_NO_ATTRIBUTION=0``.

Everything else is allowed (the hook exits 0 silently, deferring to the normal
— here, bypass — flow).

Contract (Claude Code ``PreToolUse`` hook):
  stdin  — JSON with ``tool_name``, ``tool_input`` (``.command`` for Bash),
           ``session_id``, ``cwd``, ``permission_mode``.
  deny   — print ``{"hookSpecificOutput": {"hookEventName": "PreToolUse",
           "permissionDecision": "deny", "permissionDecisionReason": ...}}``
           and exit 0. The reason is fed back to the model.
  allow  — exit 0 with no output.

Stdlib only: this file is invoked by absolute path with the session's worktree
as cwd, so it cannot rely on any package being importable.
"""

from __future__ import annotations

import fnmatch
import functools
import json
import os
import posixpath
import re
import shlex
import sys

# --- command segmentation ------------------------------------------------

# Shell operators that chain separate commands. We inspect each segment so a
# destructive command hidden after `&&`/`;`/`|`/`&`/newline is still caught.
# A single `&` backgrounds the command before it — it separates two commands
# exactly like `;` does, so leaving it out let `sleep 0 & rm -rf /etc` past.
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|&]")

# The same, MINUS the single `|`: a pipeline's stages are one statement, and
# some checks (see _destructive_database) have to see it whole.
_PIPELINE_SPLIT = re.compile(r"&&|\|\||[;\n&]")

# A leading `FOO=bar` environment assignment on a command.
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")

# Privilege-escalation prefixes we strip before classifying the real command
# (a destructive command is destructive with or without `sudo`).
_PREFIX_WORDS = {
    "sudo", "doas", "runas", "command", "nohup", "time", "exec", "env",
    "timeout", "nice", "ionice", "setsid", "stdbuf", "chrt", "unbuffer",
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
_SHELL_PROGS = {"bash", "sh", "zsh", "ksh", "dash", "ash", "busybox"}

# Programs that merely PRINT their arguments. `eval "$(echo rm -rf /etc)"` runs
# what the substitution printed, so the echo has to be peeled off to see it.
_ECHO_PROGS = {"echo", "printf"}

# Command substitutions, backticks and process substitutions all run their
# contents as a command — `cat <(rm -rf /etc)` runs the `rm` just as surely as
# `$(...)` does.
_SUBST_RE = re.compile(r"\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|>\(([^()]*)\)")


def _subst_inner(m: "re.Match[str]") -> str:
    """The command text inside whichever substitution form matched."""
    return next((g for g in m.groups() if g), "")


# Stands in for a substitution whose OUTPUT cannot be known. It must be
# non-empty and path-shaped-but-harmless: blanking a substitution left
# `rm -rf "$(mktemp -d)"` with an empty target, and an empty target read as the
# filesystem root — refusing the standard temp-dir cleanup idiom.
_OPAQUE_SUBST = "turma_substituted_value"


def _subst_text(m: "re.Match[str]") -> str:
    """What a substitution CONTRIBUTES to the command line around it.

    `rm -rf $(echo /etc)` deletes /etc, and erasing the substitution erased the
    target with it — an easier spelling than the `eval "$(echo …)"` form. Where
    the inner command only prints its arguments, those arguments ARE the text;
    anything else is opaque.
    """
    toks = _tokenize(_subst_inner(m))
    if toks and _basename(toks[0]) in _ECHO_PROGS:
        return " ".join(toks[1:])
    return _OPAQUE_SUBST


# How deep the expansion recurses before giving up (a guard against a
# pathological nest, not a security boundary).
_MAX_EXPAND_DEPTH = 6


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
_BRACE_RE = re.compile(r"\{([^{}]+,[^{}]*)\}")
_VAR_ASSIGN_RE = re.compile(
    r"(?:^|[;\n&|]|\bexport\s+)\s*([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&\n]+)"
)
_FOR_IN_RE = re.compile(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+)")
# `$NAME`, `${NAME}`, and the operator forms — `${d%/}`, `${d#x}`, `${d:0:4}`,
# `${nope:-/etc}`. The operator matters less than the value it operates on: a
# one-character `${d%/}` was enough to walk around the loop-variable fix.
_VAR_USE_RE = re.compile(
    r"\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)"
)

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
    """`rm -rf {/etc,/var}` → `rm -rf /etc /var` (prefix/suffix preserved)."""
    for _ in range(4):  # bounded: an expansion can re-create a brace
        m = _BRACE_RE.search(command)
        if not m:
            break
        start, end = m.span()
        word_start = command.rfind(" ", 0, start) + 1
        word_end = command.find(" ", end)
        if word_end == -1:
            word_end = len(command)
        prefix, suffix = command[word_start:start], command[end:word_end]
        parts = [prefix + p.strip() + suffix for p in m.group(1).split(",")]
        command = command[:word_start] + " ".join(parts) + command[word_end:]
    return command


def _var_values(command: str) -> dict[str, list[str]]:
    """Values this command line itself assigns to a variable."""
    vals: dict[str, list[str]] = {}
    for m in _VAR_ASSIGN_RE.finditer(command):
        vals.setdefault(m.group(1), []).append(m.group(2).strip("'\""))
    for m in _FOR_IN_RE.finditer(command):
        words = [w for w in m.group(2).split() if w != "do"]
        if words:
            vals.setdefault(m.group(1), []).extend(words)
    return vals


def _substitute_vars(command: str) -> str:
    """Inline variables the command line sets itself.

    Only names this very command assigns are substituted — an unresolved
    `$TMPDIR` is left alone rather than guessed at.
    """
    # NB: no early return on an empty map — `${nope:-/etc}` needs no assignment.
    vals = _var_values(command)

    def rep(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(3) or ""
        got = vals.get(name)
        op = _VAR_OP_RE.match(m.group(2) or "")
        if got:
            value = got[0] if len(got) == 1 else " ".join(got)
            return _apply_var_op(value, op.group(1), op.group(2)) if op else value
        if op and op.group(1) in _VAR_DEFAULT_OPS:
            return op.group(2)
        return m.group(0)

    return _VAR_USE_RE.sub(rep, command)


def _prenormalise(command: str) -> str:
    return _substitute_vars(_expand_braces(_IFS_RE.sub(" ", _decode_ansi_c(command))))


# `cmd <<EOF` / `<<-'EOF'` — everything up to the delimiter line is DATA fed to
# `cmd`, not commands. Newline is a segment separator, so without this every
# line of a heredoc body gets classified as a command of its own: a commit
# message documenting `DROP TABLE`, or any prose containing `rm -rf`, was
# refused. The body is still checked, but attributed to the command it feeds.
_HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def _split_heredocs(command: str) -> tuple[str, list[tuple[str, str]]]:
    """Split `command` into (commands-only text, [(owner line, body), ...])."""
    kept: list[str] = []
    bodies: list[tuple[str, str]] = []
    lines = command.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        m = _HEREDOC_START.search(line)
        i += 1
        if not m:
            continue
        delim = m.group(2)
        body: list[str] = []
        while i < len(lines) and lines[i].strip() != delim:
            body.append(lines[i])
            i += 1
        i += 1  # the delimiter line itself
        bodies.append((line, "\n".join(body)))
    return "\n".join(kept), bodies


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
    """
    out: list[str] = []
    buf: list[str] = []
    quote: str | None = None
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if quote:
            buf.append(ch)
            # Inside double quotes a backslash escapes the next character;
            # inside single quotes it does not, and nothing ends them but `'`.
            if ch == "\\" and quote == '"' and i + 1 < n:
                buf.append(command[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(command[i + 1])
            i += 2
            continue
        if command[i:i + 2] in ("&&", "||"):
            out.append("".join(buf))
            buf = []
            i += 2
            continue
        if ch in (";", "\n", "&") or (include_pipe and ch == "|"):
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    out.append("".join(buf))
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
                if "=" not in opt and opt in takes_value and out:
                    out.pop(0)
            # `timeout 5s cmd` / `nice 10 cmd`: a bare duration/priority operand.
            if wrapper in ("timeout", "nice") and out and re.match(r"^[0-9]", out[0]):
                out.pop(0)
            continue
        break
    return out


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
    """
    for i, tok in enumerate(rest):
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


def _expand_segments(command: str, depth: int = 0) -> list[tuple[list[str], str]]:
    """Every command ``command`` would actually run, as (tokens, segment) pairs.

    Splitting on shell operators alone only ever saw the OUTERMOST command, so
    `bash -c 'rm -rf /etc'`, `(rm -rf /etc)`, `$(rm -rf /etc)`, `eval '...'`,
    `xargs rm -rf` and `find / -exec rm -rf {} +` each classified as something
    harmless and sailed past every destructive check. Each of those forms is
    unwrapped here and its inner command classified on its own terms.
    """
    out: list[tuple[list[str], str]] = []
    if depth > _MAX_EXPAND_DEPTH:
        return out
    command, heredocs = _split_heredocs(_prenormalise(command))
    # A heredoc fed to a SHELL is a script, not data — `bash <<EOF ... EOF` runs
    # every line of it. Expand those bodies as commands; bodies fed to anything
    # else stay data (see _destructive_database for the psql case).
    for owner, body in heredocs:
        owner_tokens = _strip_prefixes(_tokenize(_SUBST_RE.sub(" ", owner)))
        if owner_tokens and _basename(owner_tokens[0]) in (_SHELL_PROGS | {"eval", "source", "."}):
            out.extend(_expand_segments(body, depth + 1))
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
    for raw in segments:
        # Anything a substitution would run, wherever it sits in the segment.
        for m in _SUBST_RE.finditer(raw):
            inner = _subst_inner(m)
            if inner.strip():
                out.extend(_expand_segments(inner, depth + 1))
        # A substitution also CONTRIBUTES text where it sits — `$(echo …)` is
        # what `eval "$(echo rm -rf /etc)"` runs and what `rm -rf $(echo /etc)`
        # deletes. Both fall out of substituting rather than erasing.
        seg = _unwrap_group(_SUBST_RE.sub(_subst_text, raw))
        if seg != raw.strip() and seg:
            # A group/substitution-stripped body can itself hold operators.
            if _SEGMENT_SPLIT.search(seg):
                out.extend(_expand_segments(seg, depth + 1))
                continue
        tokens = _strip_prefixes(_tokenize(seg))
        if not tokens:
            continue
        out.append((tokens, seg))
        prog = _basename(tokens[0])
        rest = tokens[1:]
        if prog in _SHELL_PROGS:
            i = _shell_c_index(rest)
            if i >= 0 and i + 1 < len(rest):
                out.extend(_expand_segments(rest[i + 1], depth + 1))
        elif prog == "eval" and rest:
            # `eval eval eval … rm -rf /etc` is valid shell. Collapse the chain
            # ITERATIVELY — recursing once per `eval` burned the depth budget,
            # and exhausting it used to fail open.
            inner = rest
            while inner and _basename(inner[0]) == "eval":
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
                out.extend(_expand_segments(" ".join(shlex.quote(t) for t in inner), depth + 1))
                # 2. The FIRST token, when it is itself a command line. A quoted
                #    script is one token and keeps that shape whatever follows
                #    it, so this covers the redirection case above.
                #    Only the first: in `eval <cmd> <args…>` the trailing tokens
                #    are ARGUMENTS, and expanding those classified
                #    `eval echo 'rm -rf /etc'` — which prints text and deletes
                #    nothing — as destructive. That is the "commit message
                #    mentioning rm -rf" class this file exists not to refuse.
                if inner[0].strip() and re.search(r"\s", inner[0]):
                    out.extend(_expand_segments(inner[0], depth + 1))
        elif prog == "trap" and rest:
            # `trap 'rm -rf /etc' EXIT` runs its handler on the way out. Scan
            # every non-flag argument, not just the first: `trap -- '<cmd>' EXIT`
            # displaces the handler by one and hid it completely.
            for tok in rest:
                if not tok.startswith("-"):
                    out.extend(_expand_segments(tok, depth + 1))
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
            if len(inner_cmd) == 1 and re.search(r"\s", inner_cmd[0]):
                out.extend(_expand_segments(inner_cmd[0], depth + 1))
            elif inner_cmd and prog in _JOINING_WRAPPERS:
                # ssh JOINS its operands and hands the string to a remote shell,
                # so `ssh host 'rm -rf /etc' 'b'` runs `rm -rf /etc b`.
                out.extend(_expand_segments(" ".join(inner_cmd), depth + 1))
            elif inner_cmd:
                out.extend(_expand_segments(
                    " ".join(shlex.quote(t) for t in inner_cmd), depth + 1))
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
                # `{}` stands for whatever the pipeline feeds in.
                expanded: list[str] = []
                for tok in inner:
                    expanded.extend(piped_operands if tok == "{}" else [tok])
                out.append((_strip_prefixes(expanded + piped_operands), seg))
        elif prog == "find":
            roots = _find_roots(tokens) or ["."]
            if "-delete" in rest:
                # Equivalent to a recursive delete of everything it walks.
                out.append((["rm", "-r", *roots], seg))
            for flag in ("-exec", "-execdir", "-ok"):
                while flag in rest:
                    i = rest.index(flag)
                    run = []
                    for tok in rest[i + 1:]:
                        if tok in (";", "+", "\\;"):
                            break
                        # `{}` stands for each path found — i.e. the roots.
                        run.extend(roots if tok == "{}" else [tok])
                    if run:
                        out.append((_strip_prefixes(run), seg))
                    rest = rest[i + 1:]
    return out


# --- dangerous-path detection (for rm / chmod / chown) -------------------

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
        if _is_dangerous_path(tgt):
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
    r"|\bglab\s+mr\b|\baz\s+repos\s+pr\b|--message\b|\bcommit\b.*-m\b",
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


def policy_reason(command: str) -> str | None:
    """Return a reason if ``command`` violates the PR workflow policy.

    Hard rules (no override): work lands via a pull request, so the agent may
    not push to / delete `main`/`master` directly, and it may not merge any
    pull request — that is a human reviewer's call.
    """
    for tokens, _segment, *_flags in _expand_segments(command):
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
        if (
            prog == "git"
            and rest
            and rest[0] == "push"
            and any(_is_protected_ref(t) for t in rest[1:] if not t.startswith("-"))
        ):
            return (
                "do not push to main/master directly — push a feature "
                "branch and open a pull request for review"
            )
    return None


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
    "docker-compose", "flatpak", "distrobox", "lxc", "incus",
}

# How many non-option OPERANDS sit between the wrapper and the command it runs:
# `ssh <host> <cmd>` is one, `docker exec <container> <cmd>` is two (the
# subcommand and the target). Used to find the command in the UNQUOTED form; the
# quoted form (`ssh h '<cmd>'`) arrives as one token and is handled separately.
_EXEC_WRAPPER_OPERANDS = {
    "ssh": 1, "nsenter": 0, "chroot": 1,
    "docker": 2, "podman": 2, "kubectl": 2, "oc": 2,
    "docker-compose": 2, "flatpak": 2, "distrobox": 2, "lxc": 2, "incus": 2,
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
    for tokens, segment, *_flags in _expand_segments(command):
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
    for pipeline in _split_on_operators(_split_heredocs(_prenormalise(command))[0],
                                        include_pipe=False):
        if not _DB_DESTRUCTION.search(pipeline):
            continue
        for stage in _split_on_operators(pipeline, include_pipe=True):
            toks = _strip_prefixes(_tokenize(_unwrap_group(_SUBST_RE.sub(" ", stage))))
            if _stage_executes_sql(toks):
                return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    # A heredoc body is data, but `psql <<EOF ... DROP DATABASE x; ... EOF` is
    # still the statement being executed — judge it by the command it feeds.
    for owner, body in _split_heredocs(command)[1]:
        if not _DB_DESTRUCTION.search(body):
            continue
        for tokens, _seg, *_flags in _expand_segments(owner):
            if _stage_executes_sql(tokens):
                return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    return None


def is_destructive(command: str) -> str | None:
    """Return a human reason if ``command`` is catastrophic, else ``None``."""
    # Fork bombs contain the `;`/`|` we segment on, so match the whole string.
    reason = _destructive_forkbomb(command)
    if reason:
        return reason
    reason = _destructive_database(command)
    if reason:
        return reason
    for tokens, segment, *flags in _expand_segments(command):
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
        for reason in checks:
            if reason:
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


def decide(
    tool_name: str,
    tool_input: dict,
    *,
    overrides: list[str] | None = None,
    no_attribution: bool = True,
) -> tuple[str, str | None, str | None]:
    """Return ``(decision, reason, category)``.

    ``decision`` is ``"allow"`` or ``"deny"``. ``category`` is
    ``"destructive"`` / ``"policy"`` / ``"attribution"`` / ``None``. Only
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

    return ("allow", None, None)


# --- hook entrypoint -----------------------------------------------------


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
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        # Fail open on a malformed event: a guard that crashes must not wedge
        # the agent. The deny rules in the settings file remain as a backstop.
        return 0
    if not isinstance(event, dict):
        return 0

    tool_name = event.get("tool_name") or ""
    tool_input = event.get("tool_input") or {}
    overrides = _parse_overrides(os.environ.get("TURMA_TOOL_GRANTS"))
    no_attribution = os.environ.get("TURMA_NO_ATTRIBUTION", "1") != "0"

    decision, reason, _category = decide(
        tool_name,
        tool_input if isinstance(tool_input, dict) else {},
        overrides=overrides,
        no_attribution=no_attribution,
    )
    if decision == "deny" and reason:
        _emit_deny(reason)
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())
