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
    # GitLab's auto-merge push options are `glab mr merge` spelt as a push:
    # the MR lands the moment its pipeline/checks pass, with no human in the
    # loop. Both spellings (classic and >= 17.11), every flag form.
    "git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds origin CE-1",
    "git push -o merge_request.auto_merge origin CE-1",
    "git push -omerge_request.auto_merge origin CE-1",
    "git push --push-option merge_request.merge_when_pipeline_succeeds origin CE-1",
    "git push --push-option=merge_request.merge_when_pipeline_succeeds origin CE-1",
    # `=value` forms too: GitLab keeps the value as a string and Ruby treats
    # ANY non-empty string as truthy, so even `=false` arms auto-merge — no
    # value disarms, so no value is safe to allow.
    "git push -o merge_request.auto_merge=true origin CE-1",
    "git push -o merge_request.auto_merge=false origin CE-1",
    "git push --push-option=merge_request.merge_when_pipeline_succeeds=1 origin CE-1",
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
    # The push-option MR creation path stays open (XERK-162) — only the
    # auto-merge options are the policy's business.
    "git push -o merge_request.create origin CE-1",
    "git push -o merge_request.create -o merge_request.target=main origin CE-1",
    "git push --push-option=merge_request.create origin CE-1",
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

    def test_eval_arguments_are_not_commands(self):
        """`eval echo 'rm -rf /etc'` PRINTS text; it deletes nothing.

        Expanding every whitespace-bearing token treated trailing ARGUMENTS as
        commands, reintroducing the "commit message mentioning rm -rf" class
        behind eval. Only the first token can be the command.
        """
        for cmd in ("eval echo 'rm -rf /etc'",
                    "eval git commit -m 'rm -rf /etc is banned'",
                    "eval printf '%s\\n' 'rm -rf /etc'",
                    "eval logger 'rm -rf /etc completed'",
                    "eval echo 'chmod -R 777 / would be bad'"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
        self.assertIsNone(guard.policy_reason("eval echo 'git push origin main is blocked'"))
        # ...while the command position still resolves.
        self.assertIsNotNone(guard.is_destructive("eval 'rm -rf /etc' > /dev/null"))
        self.assertIsNotNone(guard.is_destructive("eval bash -c 'rm -rf /etc'"))

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

    def test_segments_are_not_split_inside_quotes(self):
        """A quoted script must survive segmentation whole.

        Splitting the RAW string severed it mid-quote, so a shell's `-c`
        argument was reduced to its FIRST WORD and the rest became a segment of
        its own — `bash -c 'rm -rf /etc; echo done'` classified as the program
        `'rm`. It fired only when the destructive command came FIRST inside the
        quotes, and every existing test wrote `bash -c 'cd /tmp; rm -rf /etc'`,
        which is why it survived origin/main untouched (XERK-235).
        """
        self.assertEqual(
            guard._split_segments("bash -c 'rm -rf /etc; echo done'"),
            ["bash -c 'rm -rf /etc; echo done'"],
        )
        for cmd in ("bash -c 'rm -rf /etc; echo done'",
                    "bash -c 'rm -rf /etc && echo ok'",
                    "bash -c 'rm -rf /etc | tee log'",
                    "sh -c 'chmod -R 777 /; echo x'",
                    "eval 'rm -rf /etc; echo done'",
                    'bash -c "rm -rf /etc; echo done"'):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        for cmd in ("bash -c 'gh pr merge 1; echo done'",
                    "bash -c 'echo a; git push origin main'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_a_quoted_operator_is_not_a_command_boundary(self):
        """The other direction: stripping quotes to fix the above turns
        `rg -n 'shutdown|reboot' ansible/` into a power-state command."""
        for cmd in ("rg -n 'shutdown|reboot' ansible/", "grep -n 'a;b' f",
                    "echo 'a && b'", "git commit -m 'fix; and more'",
                    "bash -c 'npm run build; npm test'"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_a_wrappers_remote_command_is_a_command(self):
        """`ssh h 'rm -rf /'` was allowed on origin/main and here.

        A wrapper's remote command was followed through for SQL but never
        expanded as a COMMAND, so the destructive and policy rules never saw it.
        The remote host is a peer of this one — the image ships ssh/docker/
        kubectl and mounts ~/.ssh — so it is the same blast radius one hop away
        (XERK-235).
        """
        for cmd in ("ssh h 'rm -rf /'", "ssh prod 'shutdown -h now'",
                    "ssh h 'mkfs.ext4 /dev/sda1'", "ssh h 'chmod -R 777 /'",
                    "docker exec c rm -rf /etc", "docker exec -i c rm -rf /etc",
                    "kubectl exec pod -- rm -rf /etc", "ssh -p 22 h 'rm -rf /etc'",
                    "ssh h 'rm -rf /etc; echo done'"):
            with self.subTest(destructive=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        for cmd in ("ssh h 'git push origin main'", "ssh h 'gh pr merge 1'"):
            with self.subTest(policy=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))
        # ...without taking ordinary remote work with it.
        for cmd in ("ssh host 'rm -rf /tmp/build'", "ssh host 'uptime'",
                    "docker exec c rm -rf /app/node_modules", "docker exec c npm test",
                    "docker run --rm alpine echo hi", "docker build -t app .",
                    "docker run -e 'FOO=rm -rf /etc' img", "kubectl get pods -A",
                    "ssh host 'git push origin feature/x'", "kubectl exec pod -- ls /"):
            with self.subTest(allowed=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_a_compound_remote_command_still_reaches_its_client(self):
        """`ssh h 'cd /tmp && psql -c "…"'` classified as `cd` when read as one
        argv. It was only ever caught by the severed-quote bug, so fixing that
        took the protection with it."""
        drop_db = "DROP" + " DATABASE"
        for cmd in (f"ssh host 'cd /tmp && psql -c \"{drop_db} p\"'",
                    f"ssh host 'cd /tmp; psql -c \"{drop_db} p\"'",
                    f"docker exec db sh -c 'cd /; psql -c \"{drop_db} p\"'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_the_splitter_honours_escapes_and_literal_quotes(self):
        """The two behaviours of the quote-aware splitter that nothing pinned.

        Removing the backslash handling makes `echo "x\"; rm -rf /etc"` deny —
        the `\"` is escaped, so the `;` is inside the string and echo just
        prints it. Letting `'` close on `"` makes `echo 'a"b; rm -rf /etc'` deny,
        because a single-quoted body is literal.
        """
        self.assertIsNone(guard.is_destructive('echo "x\\"; rm -rf /etc"'))
        self.assertIsNone(guard.is_destructive("echo 'a\"b; rm -rf /etc'"))
        # An UNTERMINATED quote is a syntax error, so nothing runs.
        self.assertIsNone(guard.is_destructive("echo 'unterminated; rm -rf /etc"))
        # ...while the escaped-path form still denies.
        self.assertIsNotNone(guard.is_destructive("rm -rf \\/etc"))

    def test_a_wrapper_option_value_is_not_an_operand(self):
        """`ssh -i key host rm -rf /etc` — the VALUE ate the host slot.

        Counting operands without knowing which options consume a value made
        `key` the host, so the command was never found. `ssh -i key host …` and
        `docker exec -u root c …` are ordinary spellings, not evasion.
        """
        for cmd in ("ssh -i key host rm -rf /etc", "ssh -p 2222 host rm -rf /etc",
                    "ssh -o StrictHostKeyChecking=no host rm -rf /etc",
                    "ssh -l root host rm -rf /etc",
                    "docker exec -u root c rm -rf /etc",
                    "docker exec -w /app c rm -rf /etc",
                    "docker exec -e K=V c rm -rf /etc",
                    "docker --context foo exec c rm -rf /etc",
                    "kubectl -n ns exec pod rm -rf /etc"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        for cmd in ("ssh -i ~/.ssh/id_rsa host 'uptime'", "docker exec -u node c npm test"):
            with self.subTest(allowed=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_a_wrapper_argument_is_not_automatically_a_command(self):
        """The E1 mistake, reinstated for wrappers and removed again.

        Expanding every whitespace-bearing argument reads a quoted MESSAGE as a
        command: `ssh host git commit -m 'rm -rf /etc is banned'` denied. Only
        the command POSITION is a command — single-vs-multi, as eval does it.
        """
        for cmd in ("docker run --rm alpine echo 'rm -rf /etc'",
                    "ssh host git commit -m 'rm -rf /etc is banned'",
                    "kubectl exec pod -- echo 'rm -rf /etc'",
                    "docker run --label 'rm -rf /etc is bad' img",
                    "ssh host logger 'rm -rf /etc completed'",
                    "docker run -e 'CMD=rm -rf /etc' img"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_a_quoted_pipe_is_not_a_pipeline_stage(self):
        """The inner pipeline split was still naive, so a quoted `|` split and
        the text after it became an executing stage."""
        drop_tb, drop_db = "DROP" + " TABLE", "DROP" + " DATABASE"
        self.assertIsNone(guard.is_destructive(f"echo '{drop_tb} | psql -c x' > f"))
        # ...while real pipelines keep their verdicts.
        self.assertIsNotNone(guard.is_destructive(f"echo '{drop_db} p' | mysql"))
        self.assertIsNotNone(guard.is_destructive(f"echo '{drop_db} p' | docker exec -i db psql"))
        self.assertIsNone(guard.is_destructive(f"cat schema.sql | grep '{drop_tb}'"))

    def test_every_wrapper_has_an_entry_in_every_table(self):
        """`.get(prog, set())` is a silent default on a security-critical lookup.

        Seven of the twelve wrappers had no value-option entry at all, which
        silently meant "no option takes a value" and made each of them a bypass.
        This turns "we forgot podman" from a silent hole into a red test.
        """
        self.assertEqual(set(guard._EXEC_WRAPPERS), set(guard._EXEC_WRAPPER_OPERANDS))
        self.assertEqual(set(guard._EXEC_WRAPPERS), set(guard._EXEC_WRAPPER_OPTS_WITH_VALUE))

    def test_an_unknown_wrapper_option_is_not_a_bypass(self):
        """The option table CANNOT be kept complete — value-taking options are
        many and grow every release — so a miss must cost sharpness, not safety.
        Every non-option suffix is classified as an argv, so wherever the command
        really starts, one of them begins at it.
        """
        for cmd in ("ssh --madeup-flag val host rm -rf /etc",
                    "docker exec --not-a-real-flag x c rm -rf /etc",
                    "kubectl --invented thing exec pod rm -rf /etc",
                    # ...and the 27 real options we had both missed.
                    "ssh -B eth0 host rm -rf /etc", "ssh -O check host rm -rf /etc",
                    "docker -c foo exec c rm -rf /etc",
                    "docker --log-level debug exec c rm -rf /etc",
                    "kubectl --token abc exec pod rm -rf /etc",
                    "kubectl -v 5 exec pod rm -rf /etc",
                    "oc --token abc exec pod rm -rf /etc",
                    "podman --url x exec c rm -rf /etc"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_wrappers_without_a_table_entry_are_covered(self):
        """These had NO entry, so every option read as taking no value. And
        `nsenter` expects 0 operands, which made it return its own flags as the
        command with `-t` as the program."""
        for cmd in ("chroot --userspec root /mnt rm -rf /etc",
                    "lxc --project p exec c rm -rf /etc",
                    "incus --project p exec c rm -rf /etc",
                    "docker-compose -f c.yml exec db rm -rf /etc",
                    "nsenter -t 1 -m rm -rf /etc",
                    "nsenter --target 1 --mount rm -rf /etc"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_ssh_joins_its_operands_but_exec_wrappers_do_not(self):
        """`ssh host 'rm -rf /etc' 'b'` really runs `rm -rf /etc b` — ssh hands a
        joined STRING to a remote shell. `docker exec`/`kubectl exec` exec the
        argv directly, so they must keep argv semantics."""
        for cmd in ("ssh host 'rm -rf /etc' 'b'",
                    "ssh host 'cd /tmp' '&&' 'rm -rf /etc'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))
        # `ssh host 'a' 'rm -rf /etc'` runs `a rm -rf /etc` — rm is an ARGUMENT
        # to `a`, and denying it was a false positive.
        self.assertIsNone(guard.is_destructive("ssh host 'a' 'rm -rf /etc'"))

    def test_a_container_named_like_a_program_is_not_that_program(self):
        """`reboot` is an ordinary container name in a homelab.

        The disk/power rules match on argv[0] ALONE — no path, no argument — so
        once the wrapper suffix pass started classifying every argv, a container
        called `reboot` read as a power command. Suffix-derived candidates now
        run only the rules that also require a dangerous PATH (XERK-235).
        """
        for cmd in ("docker run --name reboot alpine true", "docker exec reboot ls -la",
                    "docker exec shutdown env", "kubectl exec halt -- ls",
                    "docker run --name poweroff img true",
                    "docker run --entrypoint shred img --help"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
        # ...while a real power command through a wrapper still denies, because
        # that one is found at the command POSITION, not by the suffix pass.
        self.assertIsNotNone(guard.is_destructive("ssh prod 'shutdown -h now'"))
        self.assertIsNotNone(guard.is_destructive("shutdown -h now"))
        # A suffix naming a BLOCK DEVICE is judged by the disk rules anyway — no
        # container is called /dev/sda — which recovers the device-bearing half
        # of what the narrowing above gives up.
        for cmd in ("docker --madeup v exec c mkfs.ext4 /dev/sda1",
                    "docker --madeup v exec c dd if=/dev/zero of=/dev/sda",
                    "podman --root /x exec c wipefs -a /dev/sda"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_what_follows_a_printer_is_data(self):
        """`ssh host echo rm -rf /etc` prints text; it deletes nothing."""
        for cmd in ("docker run --rm alpine echo rm -rf /etc",
                    "ssh host echo rm -rf /etc",
                    "ssh host echo git push origin main",
                    "docker run img printf 'x' rm -rf /etc",
                    "ssh host logger rm -rf /etc failed"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))
        # The printer's OWN suffix is still emitted, so a real command reached
        # only by the suffix pass keeps working.
        self.assertIsNotNone(
            guard.policy_reason("ssh --madeup-flag v host git push origin main"))

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


class TestWrapperUnwrapping(unittest.TestCase):
    """A wrapper must not launder a command past the rules.

    A QA session destroyed a host's /etc with `bash -lc 'rm -rf /etc'`: the
    outer tokens are just `bash`, so every rule saw nothing. The login shell
    also re-sourced /etc/profile and reset PATH, defeating the PATH-based `rm`
    shim the session was relying on as its safety net.
    """

    SHELL_WRAPPED = [
        "bash -c 'rm -rf /etc'",
        "bash -lc 'rm -rf /etc'",
        "bash -ec 'rm -rf /etc'",
        "sh -xc 'rm -rf /etc'",
        "bash -o pipefail -c 'rm -rf /etc'",
        "/bin/bash -lc 'rm -rf /etc'",
        "zsh -c 'rm -rf /etc'",
        "su -c 'rm -rf /etc'",
        "env FOO=1 bash -lc 'rm -rf /etc'",
        "bash -c \"bash -c 'rm -rf /etc'\"",
    ]

    PREFIX_WRAPPED = [
        "timeout 5 rm -rf /etc",
        "nice -n 5 rm -rf /etc",
        "setsid rm -rf /etc",
        "stdbuf -o0 rm -rf /etc",
        "eval rm -rf /etc",
        "xargs rm -rf /etc",
        "sudo -u root rm -rf /etc",
    ]

    # Same wrappers, harmless payloads: the unwrapping must not over-block.
    WRAPPED_SAFE = [
        "bash -lc 'npm test'",
        "bash -c 'make build'",
        "sh -c 'echo hi'",
        "timeout 30 pytest",
        "nice -n 10 make",
        "stdbuf -o0 python3 app.py",
        "env FOO=bar npm run dev",
        "bash -lc 'rm -rf node_modules'",
        "xargs -I {} echo {}",
    ]

    def test_shell_wrapped_destructive_blocked(self):
        for cmd in self.SHELL_WRAPPED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_prefix_wrapped_destructive_blocked(self):
        for cmd in self.PREFIX_WRAPPED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_wrapped_safe_still_allowed(self):
        for cmd in self.WRAPPED_SAFE:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_policy_rules_also_unwrap(self):
        for cmd in (
            "bash -lc 'git push origin main'",
            "bash -c 'gh pr merge 5'",
            "sh -c 'glab mr merge 5'",
        ):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_wrapped_feature_branch_push_allowed(self):
        self.assertIsNone(guard.policy_reason("bash -lc 'git push origin feature/x'"))

    def test_decide_denies_wrapped_destructive(self):
        decision, reason, category = guard.decide(
            "Bash", {"command": "bash -lc 'rm -rf /etc'"}
        )
        self.assertEqual((decision, category), ("deny", "destructive"))
        self.assertIsNotNone(reason)

    def test_recursion_is_depth_bounded(self):
        # Deeply nested wrappers must terminate rather than recurse forever.
        cmd = "echo hi"
        for _ in range(12):
            cmd = "bash -c " + repr(cmd)
        self.assertIsNone(guard.is_destructive(cmd))


class TestAgentServiceProtection(unittest.TestCase):
    """A session must not stop the manager that supervises it.

    Restarting `turma-agent` kills the manager of EVERY session on the host,
    including the one issuing the command, and the session cannot bring it back.
    systemd will not either: five rapid restarts trip StartLimitBurst and leave
    the unit stopped with no retry — which is how the truenas host lost its
    agent for 7.5 hours, silently, while the tunnel stayed up and the terminals
    kept working.
    """

    DOWN = [
        "systemctl restart turma-agent",
        "systemctl stop turma-agent",
        "systemctl restart turma-agent.service",
        "systemctl --user restart turma-agent",
        "systemctl disable turma-agent",
        "systemctl mask turma-agent",
        "systemctl kill turma-agent",
        "sudo systemctl restart turma-agent",
        "systemctl stop turma-agent-update.timer",
        "turma-agentctl restart",
        "turma-agentctl stop",
        "pkill -f hub-agent.py",
        "killall -9 turma-agent",
        "bash -lc 'systemctl restart turma-agent'",
        "systemctl restart nginx && systemctl restart turma-agent",
    ]

    # Looking at your own agent stays allowed, and other services are not this
    # rule's business — it is deliberately narrow.
    OK = [
        "systemctl status turma-agent",
        "systemctl is-active turma-agent",
        "systemctl show turma-agent -p KillMode",
        "systemctl cat turma-agent",
        "journalctl -u turma-agent -n 50",
        "turma-agentctl status",
        "systemctl restart nginx",
        "systemctl stop docker",
        "sudo systemctl restart sshd",
        "pkill -f my-daemon",
        "killall node",
    ]

    def test_taking_the_agent_down_is_denied(self):
        for cmd in self.DOWN:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_reading_it_and_other_services_stay_allowed(self):
        for cmd in self.OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))


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
