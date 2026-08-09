#!/usr/bin/env python3
"""Unit tests for the agent safety guard (agent/hooks/guard.py).

The guard is the backstop that makes the hands-off permission modes (`auto` by
default, or `bypassPermissions`) safe, so its classification is the
security-critical surface: it must block
catastrophic machine/whole-repo commands, PR-workflow violations, and AI
self-attribution while NOT blocking ordinary development work.

Stdlib unittest only (mirrors the image's no-pip stance; CI runs
`python3 -m unittest discover -s agent/tests`). guard.py is loaded by file path
so no package layout is assumed.
"""

import importlib.util
import json
import os
import subprocess
import sys
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD_PATH = os.path.join(AGENT_DIR, "hooks", "guard.py")

spec = importlib.util.spec_from_file_location("guard", GUARD_PATH)
guard = importlib.util.module_from_spec(spec)
sys.modules["guard"] = guard
spec.loader.exec_module(guard)


# --- destructive: must be blocked ----------------------------------------

DESTRUCTIVE = [
    "rm -rf /",
    "rm -rf /*",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf /etc",
    "rm -rf /usr/bin",
    "sudo rm -rf /",
    "FOO=bar rm -rf /",
    "cd /tmp && rm -rf /",
    "rm -rf .git",
    "rm -rf ./.git",
    "rm -rf path/to/.git",
    "rm --recursive --force /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown -h now",
    "reboot",
    "sudo poweroff",
    ":(){ :|:& };:",
    "chmod -R 777 /",
    "chown -R nobody /etc",
    "git branch -D main",
    "git filter-branch --tree-filter foo HEAD",
    "git reflog expire --expire=now --all",
    "git reset --hard origin/main",
    "git reset --hard master",
    "echo hi && rm -rf / --no-preserve-root",
    'psql -c "DROP DATABASE production"',
    "dropdb production",
    'mysql -e "DROP TABLE users"',
]

SAFE = [
    "rm -rf node_modules",
    "rm -rf build dist",
    "rm -rf ./target",
    "rm -f tmp.txt",
    "git push origin feature/x",
    "git push --force origin feature/my-branch",
    "git push --force-with-lease origin main",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git commit -m 'fix bug'",
    "git checkout -b feature/y",
    "npm install",
    "npm run build",
    "pytest -q",
    "make clean",
    "docker build -t app .",
    "chmod +x script.sh",
    "chmod -R 755 ./dist",
    "mv old.txt new.txt",
    "cargo test",
    "curl https://example.com",
    "python manage.py migrate",
]

POLICY_BLOCKED = [
    "git push origin main",
    "git push -u origin main",
    "git push --force origin main",
    "git push -f origin master",
    "git push origin HEAD:main",
    "git push origin :main",
    "git push origin --delete main",
    "gh pr merge 123",
    "gh pr merge --squash --auto",
    "gh pr merge 7 --admin",
    "glab mr merge 123",
    "glab mr merge --squash --yes",
    # Azure DevOps has no `merge` verb (XERK-226): a PR lands by being set to
    # `completed`, or by arming auto-complete — which merges it the moment its
    # policies pass, including straight off the create.
    "az repos pr update --id 12 --status completed",
    "az repos pr update --id 12 --status=completed",
    "az repos pr update --id 12 --auto-complete true",
    "az repos pr create --title t --auto-complete",
    "az repos pr create --title t --auto-complete=true",
]

POLICY_OK = [
    "git push origin feature/x",
    "git push -u origin my-branch",
    "git push --force-with-lease origin feature/login",
    "git push --force origin feature/login",
    "gh pr create --title t --body b",
    "gh pr view 12",
    "glab mr create --fill",
    "glab mr view 12",
    "az repos pr create --title t --description b",
    "az repos pr show --id 12",
    "az repos pr update --id 12 --status abandoned",
    "az repos pr update --id 12 --auto-complete false",  # DISARMING it is fine
    "git merge feature/x",  # local branch merge is fine
]

ATTRIB_BLOCKED = [
    "git commit -m 'fix' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'",
    'git commit -m "feature\n\n🤖 Generated with Claude Code"',
    "git commit -m 'x' --trailer 'Co-authored-by: Anthropic'",
    "gh pr create --title t --body 'Generated with Claude'",
    "glab mr create --title t --description 'Generated with Claude'",
    "az repos pr create --title t --description 'Generated with Claude'",
]

ATTRIB_OK = [
    "git commit -m 'Bump anthropic SDK to 1.2'",  # legit mention of a dep
    "git commit -m 'Add Claude adapter docs'",  # word 'Claude' alone, not a trailer
    "echo 'Co-Authored-By: Claude' > notes.txt",  # not a commit/PR command
    "git log --oneline",
]


# --- XERK-235: bypasses a QA pass proved against the shipped guard --------
#
# Each of these was ALLOWED and, for the git ones, demonstrated with a real
# push against a real remote. They are the regression net for the segmentation
# rewrite: the guard only ever saw the OUTERMOST command, so any wrapper,
# subshell, substitution or git global option walked straight past it.

BYPASS_DESTRUCTIVE = [
    # `-f` only suppresses prompts, and Bash here is non-interactive, so `-r`
    # alone deletes just as silently.
    "rm -r --no-preserve-root /",
    "rm -r /etc",
    "rm -r /home",
    "rm -r ~",
    "rm --recursive /etc",
    "rm -r /root/.ssh",
    # A wrapper's own options must not stop the strip.
    "sudo -u root rm -rf /etc",
    "env -i rm -rf /etc",
    "timeout 5 rm -rf /etc",
    "nice -n 5 rm -rf /etc",
    "setsid rm -rf /etc",
    # An interpreter's -c string is a command line of its own.
    "bash -c 'rm -rf /etc'",
    'sh -c "rm -rf /etc"',
    "eval 'rm -rf /etc'",
    # Subshells and groups.
    "(rm -rf /etc)",
    "{ rm -rf /etc; }",
    # Command substitution runs its contents.
    "echo $(rm -rf /etc)",
    # A single `&` separates commands exactly like `;`.
    "sleep 0 & rm -rf /etc",
    # Loop/conditional bodies leave `do`/`then` as the leading token.
    "for i in 1; do rm -rf /etc; done",
    "if true; then rm -rf /etc; fi",
    # find does the deleting itself, or hands the roots to -exec.
    "find /etc -delete",
    "find / -name x -exec rm -rf {} +",
    # xargs takes its operands from the pipe, not its argv.
    "echo /etc | xargs rm -rf",
    # --- second QA pass (XERK-235) -------------------------------------
    # Short options COMBINE, and `bash -lc` is how a shell is really invoked.
    # Matching the bare `-c` token missed every combined spelling.
    "bash -lc 'rm -rf /etc'",
    "bash -ec 'rm -rf /etc'",
    "sh -xc 'rm -rf /etc'",
    # `$IFS` is a word separator, so this is `rm -rf /etc` with no spaces in it.
    "rm${IFS}-rf${IFS}/etc",
    # The shell expands globs and braces before `rm` ever sees a path.
    "rm -rf /et*",
    "rm -rf /e??",
    "rm -rf /etc*",
    "rm -rf {/etc,/var}",
    # Repeated separators address the same directory.
    "rm -rf //etc",
    # `$'...'` is ANSI-C quoting: this spells `/etc`.
    "rm -rf $'\\x2fetc'",
    # A trap handler runs on the way out.
    "trap 'rm -rf /etc' EXIT",
    # Process substitution runs its body like `$(...)` does.
    "cat <(rm -rf /etc)",
    # `-I` detached from its value swallowed the command that followed it.
    "echo /etc | xargs -I '{}' rm -rf '{}'",
    "ls /etc | xargs -I{} rm -rf {}",
    # eval runs what the substitution PRINTED, not the echo itself.
    'eval "$(echo rm -rf /etc)"',
    # A function body, and a case arm, each lead with a token of their own.
    "f() { rm -rf /etc; }; f",
    "case x in x) rm -rf /etc;; esac",
    # The loop variable is assigned by the very command that uses it.
    "for d in /etc; do rm -rf $d; done",
    "D=/etc; rm -rf $D",
]

# Global options sit BEFORE the subcommand, so reading tokens[1] as the
# subcommand dropped the whole git policy. `git -C <path> push` is ordinary
# usage from outside a worktree, not an evasion technique.
BYPASS_POLICY = [
    # `$IFS` hides the word breaks from a whitespace-shaped reading (XERK-235).
    "git${IFS}push${IFS}origin${IFS}main",
    "gh${IFS}pr${IFS}merge${IFS}5",
    "bash -lc 'git push origin main'",
    "git -C /repo push origin main",
    "git -c user.name=x push origin main",
    "git --git-dir=.git push origin main",
    "git -C /repo -c a=b push origin master",
    # `+` is git's force marker: this rewrites remote history.
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push origin +master",
]

BYPASS_DESTRUCTIVE_GIT = ["git -C . branch -D main"]

# The SQL rule matched the raw string, so quoting `DROP TABLE` as data got you
# refused for a reason that did not apply — with no override available.
SQL_AS_TEXT_OK = [
    "grep -rn 'DROP TABLE' migrations/",
    "cat schema.sql | grep -i 'drop database'",
    "git commit -m 'drop table column from the schema doc'",
    "echo 'DROP TABLE x' > /dev/null",
    # Piped between two TEXT tools, the SQL is still only ever text.
    "cat schema.sql | grep 'DROP TABLE' | wc -l",
    "echo 'DROP TABLE x' | tee out.sql",
]

# Ordinary commands that must stay allowed. The pre-normalisation pass rewrites
# every command before it is classified, so this is the net that catches it
# rewriting a harmless one into something that looks catastrophic.
ORDINARY_OK = [
    "rm -rf node_modules", "rm -rf build/*", "rm -rf *", "rm -rf ./dist",
    "rm -rf /tmp/scratch", "rm -rf target/debug",
    "npm test", "npm run build", "make -j4", "python3 -m pytest -q",
    "bash -lc 'npm run build'", "bash -lc 'git push origin my-feature'",
    "for f in *.txt; do wc -l $f; done",
    "case $x in a) echo hi;; esac",
    "xargs -I {} echo {} < list.txt",
    "find . -name '*.pyc' -delete",
    "find . -name '*.o' | xargs rm -rf",
    "trap 'echo bye' EXIT",
    'eval "$(ssh-agent -s)"',
    "shred --help", "git reset --hard HEAD~1", "git checkout -b feature",
    "ls -la /etc", "cat /etc/hosts", "chmod +x script.sh",
    "docker compose up -d", "tar xzf a.tgz",
    "BUILD=/tmp/out; rm -rf $BUILD",
]


class TestKnownBypasses(unittest.TestCase):
    """Every case here shipped as ALLOWED and is now denied."""

    def test_destructive_bypasses_are_denied(self):
        for cmd in BYPASS_DESTRUCTIVE:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_git_history_bypasses_are_denied(self):
        for cmd in BYPASS_DESTRUCTIVE_GIT:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_policy_bypasses_are_denied(self):
        for cmd in BYPASS_POLICY:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_sql_quoted_as_text_still_allowed(self):
        """The fix must not trade a bypass for a false positive."""
        for cmd in SQL_AS_TEXT_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_real_sql_destruction_still_denied(self):
        for cmd in ("psql -c 'DROP DATABASE prod'", "dropdb prod",
                    "mysql -e 'drop table users'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_sql_piped_into_a_client_is_denied(self):
        """A pipeline is ONE statement, so per-segment judging cleared both halves.

        The SQL sits in the `echo` stage, which is exempt as a text tool, while
        the stage that EXECUTES it carries no SQL of its own. Judged separately
        both looked innocent — a regression this pass introduced against
        origin/main, where the raw string was matched whole (XERK-235).
        """
        drop_db = "DROP" + " DATABASE"
        # NB: `cat drop.sql | mysql` is NOT here — the SQL lives in the file, so
        # nothing in the command text can be matched. See the xargs limit below.
        for cmd in (f"echo '{drop_db} prod' | mysql",
                    f"printf '{drop_db} prod' | psql -h db",
                    f"echo '{drop_db} prod' | bash",
                    f"echo '{drop_db} prod' | sudo mysql -u root"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_sql_piped_into_a_non_client_is_allowed(self):
        """`_DB_CLIENTS` is a named list, not "anything that isn't a text tool".

        A python heredoc that merely MENTIONS `DROP DATABASE` executes no SQL —
        and the first draft of the pipeline rule above refused exactly that,
        which is how it was found.
        """
        drop_db = "DROP" + " DATABASE"
        for cmd in (f"echo '{drop_db} prod' | python3 -c 'import sys; print(sys.stdin.read())'",
                    f"python3 - <<'EOF'\nSQL = '{drop_db} prod'\nprint(SQL)\nEOF"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_ordinary_commands_survive_prenormalisation(self):
        for cmd in ORDINARY_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    # --- second QA gate (XERK-235) -------------------------------------
    #
    # An adversarial pass over the fixes above found that several of them were
    # incomplete in a way that reopened the family they closed, and that three
    # behaviours had become WORSE than origin/main. Each case is pinned here.

    def test_xargs_optional_value_options_do_not_eat_the_command(self):
        """`-i`/`-e` take an OPTIONAL, ATTACHED value — they are not `-I`.

        Listing them as value-taking made xargs eat `rm` as the option's value,
        reopening the bypass the `-I` fix had just closed, and losing `-e`
        coverage origin/main had.
        """
        for cmd in ("echo /etc | xargs -i rm -rf {}",
                    "echo x | xargs -e rm -rf /etc",
                    "echo /etc | xargs --replace rm -rf {}"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_eval_chains_collapse_instead_of_exhausting_the_depth(self):
        """`eval eval … rm -rf /etc` is valid shell and ran the rm.

        Recursing once per `eval` spent the depth budget, and exhausting it
        returned no segments at all — i.e. it failed OPEN.
        """
        for n in (1, 2, 6, 7, 20):
            with self.subTest(evals=n):
                self.assertIsNotNone(guard.is_destructive("eval " * n + "rm -rf /etc"))

    def test_trap_handler_is_found_past_leading_arguments(self):
        for cmd in ("trap -- 'rm -rf /etc' EXIT",
                    "trap -p 'rm -rf /etc' EXIT",
                    "trap 'rm -rf /etc' EXIT"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_a_substitution_contributes_its_text(self):
        """Erasing a substitution erased the TARGET standing in it.

        `rm -rf $(echo /etc)` is a simpler spelling than the `eval "$(echo …)"`
        form that was caught, and it deletes exactly the same directory.
        """
        for cmd in ("rm -rf $(echo /etc)", "rm -rf `echo /etc`",
                    "rm -rf $(printf /etc)", "rm -rf /et$(echo c)",
                    "chown -R nobody $(echo /etc)",
                    'eval "$(echo rm -rf /etc)"'):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_an_unknowable_substitution_is_not_the_filesystem_root(self):
        """The temp-dir cleanup idiom must not read as `rm -rf /`.

        Blanking a substitution left an EMPTY target, and an empty target took
        the "" branch that means the filesystem root.
        """
        for cmd in ('rm -rf "$(mktemp -d)"', 'rm -r "$(mktemp -d)"',
                    'rm -rf "$(go env GOCACHE)"', 'rm -rf "`mktemp -d`"',
                    'rm -rf ""', 'rm -rf "$(pwd)/build"',
                    "trap 'rm -rf \"$(mktemp -d)\"' EXIT"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_parameter_expansion_operators_are_applied(self):
        """A one-character operator was enough to walk around the path rules."""
        for cmd in ("rm -rf ${nope:-/etc}",
                    "for d in /etc/; do rm -rf ${d%/}; done",
                    "d=x/etc; rm -rf ${d#x}",
                    "d=/xtc; rm -rf ${d//x/e}",
                    "d=/etcXXX; rm -rf ${d:0:4}"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_path_normalisation_covers_dot_segments_and_named_homes(self):
        for cmd in ("rm -rf /./etc", "rm -rf /tmp/../etc", "rm -rf /.//etc",
                    "chmod -R 777 /./etc", "rm -rf ~root"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        # ...without dragging ordinary relative paths in with them.
        for cmd in ("rm -rf ./build", "rm -rf src/../dist", "rm -rf ~/scratch/x"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_sql_is_judged_on_execution_not_on_mention(self):
        """The rule was "deny unless the program is a text tool", which is far
        too wide: it refused a `python3 -c` that PRINTS the statement, a shell
        COMMENT mentioning it, and a `gh issue create` whose title proposed
        blocking it. Both halves are pinned — a wrapper is still followed
        through to the client it runs.
        """
        drop_db, drop_tb = "DROP" + " DATABASE", "DROP" + " TABLE"
        for cmd in (f"echo '{drop_db} prod' | docker exec -i db psql",
                    f"echo '{drop_db} prod' | kubectl exec -i pod -- psql",
                    f"echo '{drop_db} prod' | ssh dbhost psql",
                    f"echo '{drop_db} prod' | pgcli",
                    f"docker exec db psql -c '{drop_db} prod'",
                    "dropdb prod"):
            with self.subTest(executes=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        for cmd in (f"python3 -c \"print('{drop_tb}')\"",
                    f"node -e \"console.log('{drop_tb}')\"",
                    f"make lint  # catches {drop_tb} in migrations",
                    f"npm run test -- --grep '{drop_tb}'",
                    f"gh issue create --title 'Guard should block {drop_db}'",
                    f"terraform plan -var 'sql={drop_tb}'"):
            with self.subTest(mentions=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    # --- third QA gate (XERK-235): regressions the FIXES introduced ---------

    def test_the_opaque_placeholder_cannot_launder_a_root(self):
        """`rm -rf /$(cat x)` IS `rm -rf /` when the substitution prints nothing.

        Substituting a placeholder instead of erasing fixed the mktemp false
        positive, but a placeholder that is harmless as a whole token is NOT
        harmless appended to a bare root.
        """
        for cmd in ("rm -rf /$(cat target.txt)", "rm -rf /$(basename /etc)",
                    "rm -rf /`basename /etc`", "rm -rf ~/$(cat x)",
                    "chmod -R 777 /$(cat t)", "chown -R nobody /$(cat t)"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        # ...while the whole-token case stays allowed (the D10 fix).
        for cmd in ('rm -rf "$(mktemp -d)"', 'rm -rf "$(pwd)/build"',
                    'rm -rf "$(go env GOCACHE)"'):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_opaque_placeholder_is_non_empty(self):
        """The invariant the rule above turns on.

        Setting it to "" passed every other test in this file while silently
        restoring the empty-target-reads-as-root bug.
        """
        self.assertTrue(guard._OPAQUE_SUBST)
        self.assertNotIn("/", guard._OPAQUE_SUBST)

    def test_eval_requotes_when_it_rejoins(self):
        """shlex.split strips the quotes, so a plain join regroups the argv.

        `eval bash -c 'rm -rf /etc'` rejoined to `bash -c rm -rf /etc`, where
        `-c`'s argument is the bare word `rm` and the target vanished. One eval
        was enough — this was never about the depth cap.
        """
        for cmd in ("eval bash -c 'rm -rf /etc'", "eval sh -c 'rm -rf /etc'",
                    "eval eval bash -c 'rm -rf /etc'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        self.assertIsNone(guard.is_destructive("eval bash -c 'npm run build'"))

    def test_a_wrapper_carrying_a_quoted_remote_command(self):
        """`ssh db 'psql -c "..."'` is ONE token whose basename is the whole
        string, so a per-token client test never matched it — and a shell run by
        a wrapper executes what it is piped just as a top-level shell does.
        """
        drop_db = "DROP" + " DATABASE"
        for cmd in (f"ssh dbhost 'psql -c \"{drop_db} p\"'",
                    f"docker exec db sh -c 'psql -c \"{drop_db} p\"'",
                    f"echo '{drop_db} p' | docker exec -i db sh"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        for cmd in ("ssh host 'uptime'", "docker exec app sh -c 'ls /'"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    # --- fourth QA gate (XERK-235) -----------------------------------------

    def test_eval_is_not_branched_on_token_count(self):
        """A redirection is a token but not argv.

        Branching single-vs-multi on `len(inner)` sent `eval '<cmd>' > /dev/null`
        down the argv path, where re-quoting folded the whole payload into one
        word — the exact failure that re-quoting was added to prevent.
        """
        for cmd in ("eval 'rm -rf /etc' > /dev/null", "eval 'rm -rf /etc' 2>/dev/null",
                    "eval 'rm -rf /etc' >/tmp/log 2>&1"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        self.assertIsNone(guard.is_destructive("eval 'echo hi' > /dev/null"))

    def test_a_shell_is_judged_on_what_it_runs(self):
        """Concluding from the shell's PRESENCE denied ordinary work.

        `docker exec app sh -c 'grep …'` runs grep. Scanning every word of every
        wrapper argument made any shell anywhere mean "executes SQL", so a
        `DROP TABLE` search string denied — and `docker exec … sh -c` is one of
        the most common commands in this repo's own world.
        """
        drop_tb, drop_db = "DROP" + " TABLE", "DROP" + " DATABASE"
        for cmd in (f"docker exec app sh -c 'grep \"{drop_tb}\" /app/schema.sql'",
                    f"docker exec app sh -c 'ls /data' # schema has {drop_tb}",
                    f"docker run --rm alpine sh -c 'echo {drop_tb}'",
                    f"bash -c 'grep \"{drop_tb}\" schema.sql'"):
            with self.subTest(allowed=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
        # ...while a shell that really reaches a client, or reads stdin, does.
        for cmd in (f"docker exec db sh -c 'psql -c \"{drop_db} p\"'",
                    f"echo '{drop_db} p' | docker exec -i db sh",
                    f"echo '{drop_db} p' | kubectl exec -i pod -- bash",
                    f"bash -c \"psql -c '{drop_db} p'\""):
            with self.subTest(denied=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_a_named_home_prefix_is_a_root_too(self):
        for cmd in ("rm -rf ~root/$(cat t)", "rm -rf ~ubuntu/$(cat t)"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_an_ordinary_prefix_before_a_substitution_stays_allowed(self):
        """The NEGATIVE side of the placeholder rule, which nothing pinned.

        Widening the prefix test to "any prefix at all" passed every other test
        here while re-breaking the whole mktemp class in a new form.
        """
        for cmd in ("rm -rf build/$(cat t)", "rm -rf /tmp/$(cat t)",
                    "rm -rf ./$(cat t)", "rm -rf target/$(git rev-parse HEAD)"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_tokenising_is_memoised(self):
        """The hook runs before EVERY Bash call, so its cost is on the critical path.

        Each segment is tokenised several times per command (the piped-operand
        sweep, the classification pass, then each unwrapped executor), and
        `shlex` is the most expensive thing here. Asserting cache HITS rather
        than wall-clock keeps this deterministic in CI.
        """
        guard._tokenize_cached.cache_clear()
        guard.is_destructive("echo /etc | xargs rm -rf && git status")
        self.assertGreater(guard._tokenize_cached.cache_info().hits, 0)

    def test_tokenize_returns_a_private_list(self):
        """Memoising must not hand two callers the same mutable list."""
        a = guard._tokenize("rm -rf /tmp/x")
        b = guard._tokenize("rm -rf /tmp/x")
        self.assertEqual(a, b)
        self.assertIsNot(a, b)
        a.append("mutated")
        self.assertNotIn("mutated", guard._tokenize("rm -rf /tmp/x"))

    def test_xargs_from_a_file_is_a_known_limit(self):
        """Documented, not silently believed to be covered.

        `xargs rm -rf < list.txt` takes its operands from a file the guard
        cannot read, so the target is undecidable at check time. Denying it
        would also refuse `find . | xargs rm -rf`, an everyday idiom, so it is
        left allowed and written down in qa.md instead.
        """
        self.assertIsNone(guard.is_destructive("xargs -I '{}' rm -rf '{}' < list.txt"))

    def test_wrapped_ordinary_work_still_allowed(self):
        """Unwrapping must not make routine commands look destructive."""
        for cmd in ("bash -c 'npm run build'", "timeout 30 pytest",
                    "sudo -u root systemctl status nginx",
                    "find . -name '*.pyc' -delete",
                    "find . -name '*.tmp' -exec rm -f {} +",
                    "rm -r build/", "rm -rf node_modules",
                    "git -C /repo push origin my-feature",
                    "echo ./dist | xargs rm -rf"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_heredoc_body_is_data_not_commands(self):
        """Prose in a heredoc must not be classified line by line.

        Newline is a segment separator, so every line of a `git commit -m
        "$(cat <<EOF ...)"` body was read as its own command — documenting a
        `DROP TABLE` or an `rm -rf` in a commit message got you refused. Found
        by this very commit being blocked (XERK-235).
        """
        drop_table = "DROP" + " TABLE"
        doc = (
            "git commit -q -m \"$(cat <<'EOF'\n"
            f"- the SQL rule matched the raw string, so `grep -rn '{drop_table}' m/`\n"
            "  was refused; `rm -rf /etc` in prose was too.\n"
            "EOF\n)\""
        )
        self.assertIsNone(guard.is_destructive(doc))
        self.assertIsNone(guard.policy_reason(doc))
        self.assertIsNone(
            guard.is_destructive(f"cat <<EOF > notes.md\n{drop_table} users\nEOF")
        )

    def test_heredoc_fed_to_a_shell_is_still_commands(self):
        """Stripping heredoc bodies must not become a bypass of its own."""
        for cmd in ("bash <<EOF\nrm -rf /etc\nEOF",
                    "sh <<'EOF'\nrm -rf /etc\nEOF",
                    "bash <<-EOF\ngit push origin main\nEOF"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(
                    guard.is_destructive(cmd) or guard.policy_reason(cmd)
                )

    def test_heredoc_fed_to_a_db_client_is_still_executed(self):
        drop_db = "DROP" + " DATABASE"
        self.assertIsNotNone(
            guard.is_destructive(f"psql mydb <<EOF\n{drop_db} prod;\nEOF")
        )

    def test_help_on_a_disk_tool_is_not_a_format(self):
        self.assertIsNone(guard.is_destructive("shred --help"))
        self.assertIsNotNone(guard.is_destructive("shred /dev/sda"))


class TestClassification(unittest.TestCase):
    def test_destructive_blocked(self):
        for cmd in DESTRUCTIVE:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_safe_allowed(self):
        for cmd in SAFE:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_policy_blocked(self):
        for cmd in POLICY_BLOCKED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_policy_allowed(self):
        for cmd in POLICY_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.policy_reason(cmd))

    def test_attribution_blocked(self):
        for cmd in ATTRIB_BLOCKED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.attribution_reason(cmd))

    def test_attribution_allowed(self):
        for cmd in ATTRIB_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.attribution_reason(cmd))


class TestDecide(unittest.TestCase):
    def test_allows_non_bash(self):
        self.assertEqual(
            guard.decide("Edit", {"file_path": "/etc/passwd"}), ("allow", None, None)
        )

    def test_blocks_destructive_bash(self):
        decision, reason, category = guard.decide("Bash", {"command": "rm -rf /"})
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "destructive")
        self.assertTrue(reason)

    def test_override_permits_specific_command(self):
        overrides = guard._parse_overrides("Bash(rm -rf /opt/app)")
        decision, _r, _c = guard.decide(
            "Bash", {"command": "rm -rf /opt/app"}, overrides=overrides
        )
        self.assertEqual(decision, "allow")
        # A different destructive command is still blocked.
        decision2, _r2, _c2 = guard.decide(
            "Bash", {"command": "rm -rf /etc"}, overrides=overrides
        )
        self.assertEqual(decision2, "deny")

    def test_blocks_pr_policy_without_override(self):
        decision, reason, category = guard.decide(
            "Bash", {"command": "git push origin main"}
        )
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "policy")
        self.assertTrue(reason)
        # Policy is a hard rule — an override grant does NOT unblock it.
        overrides = guard._parse_overrides("Bash(git push origin main)")
        decision2, _r, cat2 = guard.decide(
            "Bash", {"command": "git push origin main"}, overrides=overrides
        )
        self.assertEqual(decision2, "deny")
        self.assertEqual(cat2, "policy")

    def test_blocks_pr_self_merge(self):
        decision, _r, category = guard.decide(
            "Bash", {"command": "gh pr merge 5 --squash"}
        )
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "policy")

    def test_attribution_can_be_disabled(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude'"
        self.assertEqual(guard.decide("Bash", {"command": cmd}, no_attribution=True)[0], "deny")
        self.assertEqual(guard.decide("Bash", {"command": cmd}, no_attribution=False)[0], "allow")

    def test_parse_overrides_extracts_bash_only(self):
        self.assertEqual(
            guard._parse_overrides("Read,Edit,Bash(rm -rf x),Write"), ["rm -rf x"]
        )
        self.assertEqual(guard._parse_overrides(None), [])


class TestHookEntrypoint(unittest.TestCase):
    """Invoke guard.py as a subprocess the way Claude Code runs the hook."""

    def _run_hook(self, event, env_extra=None):
        env = {**os.environ, **(env_extra or {})}
        return subprocess.run(
            [sys.executable, GUARD_PATH],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env=env,
        )

    def test_denies_destructive(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}
        proc = self._run_hook(event)
        self.assertEqual(proc.returncode, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_allows_safe_command(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "npm test"}}
        proc = self._run_hook(event)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")  # allow = silent exit 0

    def test_attribution_denied(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'"
        proc = self._run_hook({"tool_name": "Bash", "tool_input": {"command": cmd}})
        out = json.loads(proc.stdout)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_attribution_toggle_off_allows(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude'"
        proc = self._run_hook(
            {"tool_name": "Bash", "tool_input": {"command": cmd}},
            {"TURMA_NO_ATTRIBUTION": "0"},
        )
        self.assertEqual(proc.stdout.strip(), "")

    def test_env_override_allows_destructive(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "rm -rf /opt/app"}}
        proc = self._run_hook(event, {"TURMA_TOOL_GRANTS": "Bash(rm -rf /opt/app)"})
        self.assertEqual(proc.stdout.strip(), "")

    def test_malformed_input_fails_open(self):
        proc = subprocess.run(
            [sys.executable, GUARD_PATH],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
