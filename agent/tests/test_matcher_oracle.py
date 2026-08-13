#!/usr/bin/env python3
"""End-to-end oracle for the permission layer: run the REAL claude binary.

**Why this file exists.** Every other test of the guard settings asserts the
rule STRING that `build_guard_settings()` emits. That oracle cannot catch the
one defect class this layer actually has: a belief about Claude Code's matcher
that is wrong, encoded identically in the code and in its test, so the suite is
green while the control does nothing. Four shipped that way --

    Edit(/abs/**)      one leading slash resolves against the SETTINGS FILE's
                       directory, so the rule bound to nothing
    t[[]1[]]           the `[c]` spelling wrapped `]` too, and denied nothing
    _glob_literal      escaped `*` and `[` but not `\\`
    python3 -sE        dropped the USER site dir only; the interpreter's own
                       site-packages still ran a planted .pth inside every hook

-- and each one was green under a string assertion. The predicate in
`hooks/fileguard.py` has had ZERO defects over the same period, because its
tests call `decide()` and assert allow/deny: a real oracle. This file gives the
settings layer the same thing, and turns a Claude Code upgrade that changes
matcher semantics into a red test instead of a silently unprotected fleet.

**Structural requirements, each one learned by getting it wrong tonight.**

  CONTROL     A case with no rules at all must come back ALLOWED. Without it a
              harness that cannot observe a write reports DENIED for everything
              and looks like a pass.
  BASELINE    Claude Code gates writes under ~/.claude on its own, so a DENIED
              there proves nothing until the same case is run with EMPTY
              settings. Only the difference is attributable to our rules.
  CONTENT     Assert the file's CONTENT, not its existence: the binary creates
              ~/.claude.json itself, which read as a false ALLOWED.
  IN-CWD      `acceptEdits` only auto-approves edits inside the working
              directory. With the target outside it, the approval gate masks
              every ALLOW as a false DENY.
  RETRY       The model layer is nondeterministic -- a run where nothing was
              written can be the model declining, not a policy decision. That
              is INCONCLUSIVE, it is retried, and it FAILS if it persists. It
              must never read as a deny.

**Cost and gating.** Each case is one haiku turn against the live API, so this
is not a per-PR CI test. It is gated on TURMA_MATCHER_ORACLE=1 and is the test
to run when changing any rule spelling, any hook invocation, or when moving to
a new Claude Code version. It never writes to the real ~/.claude: cases that
need a config dir get a fake HOME with the login symlinked in read-only.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)

MODEL = os.environ.get("TURMA_MATCHER_ORACLE_MODEL", "claude-haiku-4-5-20251001")
CREDS = os.path.expanduser("~/.claude/.credentials.json")
ENABLED = os.environ.get("TURMA_MATCHER_ORACLE") == "1"
HAVE_CLAUDE = shutil.which("claude") is not None

ALLOWED, DENIED, INCONCLUSIVE = "ALLOWED", "DENIED", "INCONCLUSIVE"


def _attempt(workdir, settings_path, target, env=None, tries=3):
    """Have the model attempt one Write at `target`; report what the gate did.

    Returns ALLOWED (the content arrived), DENIED (the tool was refused), or
    INCONCLUSIVE (the model never called the tool) -- the caller must treat the
    last as a failure, never as a deny.
    """
    marker = "hello-oracle"
    for _ in range(tries):
        if os.path.exists(target):
            os.unlink(target)
        dbg = os.path.join(workdir, "dbg.log")
        proc = subprocess.run(
            ["claude", "-p",
             f"Use the Write tool to create the file {target} containing exactly "
             f"the word {marker}. Do not ask for confirmation; call the tool once.",
             "--settings", settings_path, "--model", MODEL,
             # acceptEdits + a target inside cwd: otherwise the approval gate,
             # not the deny rules, is what the case measures.
             "--permission-mode", "acceptEdits",
             "--debug", "permissions", "--debug-file", dbg],
            cwd=workdir, capture_output=True, text=True, timeout=300,
            # Not optional: the fake-HOME cases pass HOME here, and dropping it
            # would point them at the REAL ~/.claude.
            env=env or os.environ.copy())
        if os.path.exists(target):
            try:
                with open(target, errors="replace") as fh:
                    if marker in fh.read():
                        return ALLOWED      # content, not existence
            except OSError:
                pass
        log = ""
        if os.path.exists(dbg):
            with open(dbg, errors="replace") as fh:
                log = fh.read()
        said = log + (proc.stdout or "")
        if ("denied by your permission" in said
                or "shared Claude configuration" in said
                or "Write tool permission denied" in said):
            return DENIED
    return INCONCLUSIVE


def _settings(dirpath, payload):
    os.makedirs(dirpath, exist_ok=True)
    path = os.path.join(dirpath, "settings.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return path


@unittest.skipUnless(ENABLED and HAVE_CLAUDE,
                     "live-binary oracle: set TURMA_MATCHER_ORACLE=1 (costs API "
                     "calls). Run it when changing a rule spelling, a hook "
                     "invocation, or the Claude Code version.")
class TestMatcherSemantics(unittest.TestCase):
    """Every belief the settings layer encodes, measured against the binary.

    These need no ~/.claude: the questions are about the MATCHER, so the
    targets are ordinary directories under a temp dir.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="oracle-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _case(self, deny, target_rel):
        base = os.path.join(self.tmp, str(abs(hash((tuple(deny), target_rel)))))
        target = os.path.join(base, target_rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # The settings file lives in a SUBDIRECTORY of the working directory so
        # a single-leading-slash rule has somewhere wrong to resolve to.
        sp = _settings(os.path.join(base, "cfg"),
                       {"permissions": {"deny": [d.replace("{B}", base) for d in deny]}})
        got = _attempt(base, sp, target)
        self.assertNotEqual(got, INCONCLUSIVE,
                            f"model never attempted the write for deny={deny}; "
                            "inconclusive is not a deny")
        return got

    def test_control_no_rules_is_writable(self):
        """Falsifiability check: with no rules the write MUST land.

        If this fails every other case in the class is meaningless, because a
        harness that cannot see an allow reports a deny for everything.
        """
        self.assertEqual(self._case([], "t/x.txt"), ALLOWED)

    def test_absolute_rule_needs_a_doubled_leading_slash(self):
        # The defect: `Edit(/abs/**)` reads as relative to the settings file's
        # directory. Measured both ways -- the doubled slash denies, the single
        # slash binds to nothing at all.
        self.assertEqual(self._case(["Edit(/{B}/t/**)"], "t/x.txt"), DENIED)
        self.assertEqual(self._case(["Edit({B}/t/**)"], "t/x.txt"), ALLOWED)

    def test_a_deny_on_a_directory_takes_its_whole_subtree(self):
        """The single most load-bearing fact about this matcher.

        It is why `Edit(~/.claude/*)` could not be used to carve out the memory
        trees: the rule matches the `agent-memory` DIRECTORY entry, and taking
        its subtree makes it identical to denying everything.
        """
        self.assertEqual(self._case(["Edit(/{B}/t)"], "t/deep/x.txt"), DENIED)

    def test_backslash_escapes_glob_metacharacters(self):
        # What `_glob_literal` relies on: a backslash makes `[` and `*` literal,
        # and the escaped form does not overreach onto a neighbour.
        self.assertEqual(self._case([r"Edit(/{B}/t\[1]/**)"], "t[1]/x.txt"), DENIED)
        self.assertEqual(self._case([r"Edit(/{B}/st\*r/**)"], "st*r/x.txt"), DENIED)
        self.assertEqual(self._case([r"Edit(/{B}/st\*r/**)"], "stXr/x.txt"), ALLOWED)
        # Unescaped, the same rule swallows an unrelated directory.
        self.assertEqual(self._case(["Edit(/{B}/st*r/**)"], "stXr/x.txt"), DENIED)

    def test_the_character_class_spelling_that_shipped_denies_nothing(self):
        """Precisely which `[c]` spelling was broken -- the general claim is false.

        `_glob_literal` once wrapped every char of `*?[]`, so `t[1]` became
        `t[[]1[]]`. THAT denies nothing. `[[]` on its own does escape `[`
        correctly, so "the character-class spelling escapes nothing" is wrong
        and must not be repeated. The backslash above is what we rely on.
        """
        self.assertEqual(self._case(["Edit(/{B}/t[[]1[]]/**)"], "t[1]/x.txt"), ALLOWED)
        self.assertEqual(self._case(["Edit(/{B}/t[[]1]/**)"], "t[1]/x.txt"), DENIED)

    def test_a_literal_question_mark_has_no_escape(self):
        # Why `runtime_code_deny_rules` refuses to emit a rule for such a path
        # and warns instead: escaped it matches nothing, unescaped it overreaches.
        self.assertEqual(self._case([r"Edit(/{B}/q\?k/**)"], "q?k/x.txt"), ALLOWED)
        self.assertEqual(self._case(["Edit(/{B}/q?k/**)"], "qXk/x.txt"), DENIED)

    def test_write_rules_are_inert_and_edit_rules_cover_write(self):
        # Claude Code warns about this at startup and it is easy to re-introduce:
        # only Edit(path) rules are matched by file permission checks.
        self.assertEqual(self._case(["Write(/{B}/t/**)"], "t/x.txt"), ALLOWED)
        self.assertEqual(self._case(["Edit(/{B}/t/**)"], "t/x.txt"), DENIED)


@unittest.skipUnless(ENABLED and HAVE_CLAUDE and os.path.exists(CREDS),
                     "live-binary oracle over a fake ~/.claude: needs "
                     "TURMA_MATCHER_ORACLE=1 and a credentials file to symlink")
class TestGuardedClaudeDir(unittest.TestCase):
    """The feature itself, driven through the real binary.

    HOME points at a sandbox, so `~` in a rule and `~/.claude` in the hook both
    resolve there and the real config directory is never written. The login is
    symlinked in read-only so the binary can still authenticate.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="oracle-home-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _case(self, target_rel, baseline=False):
        base = os.path.join(self.tmp, ("base_" if baseline else "real_")
                            + target_rel.replace("/", "_"))
        home = os.path.join(base, "home")
        os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
        os.symlink(CREDS, os.path.join(home, ".claude", ".credentials.json"))
        target = os.path.join(home, target_rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # `baseline` is EMPTY settings: it measures what Claude Code does on its
        # own, so a deny can be attributed to our layer rather than to the
        # binary's own gate on its config directory.
        sp = _settings(os.path.join(base, "turma"),
                       {} if baseline else ha.build_guard_settings())
        return _attempt(home, sp, target, env=dict(os.environ, HOME=home))

    def test_a_subagent_memory_store_is_writable(self):
        """THE FEATURE. This is what the whole carve-out exists to permit.

        With the old blanket `Edit(~/.claude/**)` this was refused, which is why
        no Turma session or subagent has ever recorded a memory.
        """
        self.assertEqual(self._case(".claude/agent-memory/qa/note.md"), ALLOWED)

    def test_the_agent_definitions_are_still_refused(self):
        self.assertEqual(self._case(".claude/agents/evil.md"), DENIED)

    def test_the_shell_snapshots_are_still_refused(self):
        # Sourced by every Bash call of every live session: a write here is RCE
        # across sessions, and it is the hole the enumerated-pattern attempt had.
        self.assertEqual(self._case(".claude/shell-snapshots/x.sh"), DENIED)

    def test_paths_no_pattern_names_are_refused_by_the_hook(self):
        # The hook is what makes coverage complete: no backstop pattern names
        # settings.json, and ~/.claude.json is a SIBLING of the directory.
        self.assertEqual(self._case(".claude/settings.json"), DENIED)
        self.assertEqual(self._case(".claude.json"), DENIED)

    def test_project_auto_memory_is_gated_by_the_binary_not_by_us(self):
        """A limit the carve-out cannot lift, pinned so a future release shows up.

        `~/.claude/projects/<slug>/memory/` is where a SESSION's own auto-memory
        goes, and Claude Code refuses a Write there in `auto` and `acceptEdits`
        with NO settings at all -- the baseline arm below is the proof. No allow
        rule pre-grants it either (literal-slug and whole-tree allows were both
        measured), and only `bypassPermissions` lands it. So dropping the
        blanket deny is NECESSARY BUT NOT SUFFICIENT for session auto-memory:
        the subagent store is what this change actually delivers.
        """
        rel = ".claude/projects/slug/memory/MEMORY.md"
        self.assertEqual(self._case(rel), DENIED)
        self.assertEqual(self._case(rel, baseline=True), DENIED,
                         "no longer gated by the binary itself -- re-measure "
                         "whether our layer is now what blocks session memory")

    def test_the_memory_directory_entry_itself_is_not_writable(self):
        # A FILE planted at this name makes the directory impossible to create,
        # permanently disabling that agent's memory.
        self.assertEqual(self._case(".claude/agent-memory/qa"), DENIED)


if __name__ == "__main__":
    unittest.main()
