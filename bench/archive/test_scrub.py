#!/usr/bin/env python3
"""Tests for the redactor that gates what leaves the box (XERK-445).

`scrub.py` is a security control with a security control's failure mode: it
fails silently and nothing downstream notices. Every case here is a defect that
was actually present and shipped once -- a QA pass proved all three mutations
below (max->sum, precedence removal, rule-loop deletion) escaped every project
gate, because nothing under bench/ was executed by CI at all.
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrub import scrub, sensitivity  # noqa: E402


class TestRedaction(unittest.TestCase):
    def assert_gone(self, text, *needles):
        out = scrub(text)
        for n in needles:
            self.assertNotIn(n, out, f"{n!r} survived in {out!r}")
        return out

    def test_openai_key(self):
        self.assert_gone("key sk-abcdefghijklmnopqrst1234", "sk-abcdefghijklmnopqrst1234")

    def test_github_token_families(self):
        # ghs_/ghu_/ghr_ are as real as ghp_; catching only ghp_ is the bug.
        for pre in ("ghp", "gho", "ghu", "ghs", "ghr"):
            tok = f"{pre}_" + "a" * 30
            self.assert_gone(f"token {tok}", tok)

    def test_aws_key_and_secret(self):
        self.assert_gone("AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE")
        self.assert_gone("ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE")
        # The identifier is not the credential. The secret must go too.
        secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        self.assert_gone(f"aws_secret_access_key = {secret}", secret)

    def test_private_key_truncated(self):
        # Claude Code truncates Bash output constantly, so a rule that needs a
        # matching -----END----- misses the realistic case.
        self.assert_gone(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n… (output truncated)",
            "MIIEowIBAAKCAQEA")

    def test_private_key_block_variant(self):
        self.assert_gone(
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\nSECRETBYTES\n"
            "-----END PGP PRIVATE KEY BLOCK-----", "SECRETBYTES")

    def test_subdomained_email_local_part(self):
        # Ordering bug: the host rule rewrote mail.xerktech.com first, leaving
        # `ops@<INTERNAL_HOST>` with the local part intact.
        self.assert_gone("ops@mail.xerktech.com", "ops")

    def test_rfc1918_ranges(self):
        out = self.assert_gone("172.16.5.4 10.99.1.2 192.168.1.1",
                               "172.16.5.4", "10.99.1.2", "192.168.1.1")
        self.assertEqual(out.count("<INTERNAL_IP>"), 3)

    def test_slack_google_npm(self):
        self.assert_gone("xoxb-123456789012-abcdefghijkl", "xoxb-")
        self.assert_gone("AIza" + "B" * 35, "AIza" + "B" * 35)
        self.assert_gone("npm_" + "c" * 36, "npm_" + "c" * 36)

    def test_jwt_and_bearer(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl"
        self.assert_gone(jwt, jwt)
        self.assert_gone("Authorization: Bearer abcdef1234567890XYZ",
                         "abcdef1234567890XYZ")

    def test_internal_identifiers(self):
        self.assert_gone("https://xerktech.atlassian.net/browse/XERK-1",
                         "atlassian.net")
        self.assert_gone("/mnt/data/Docker/git/.turma/worktrees/Turma/abc",
                         "/mnt/data")
        self.assert_gone("cd /home/someone/git/Turma", "someone")

    def test_jira_people_lines(self):
        # Jira exports are the PII source in our own task files.
        self.assert_gone("- Assignee: Some Person", "Some Person")
        self.assert_gone("Reporter: Another Person", "Another Person")


class TestDoesNotCorrupt(unittest.TestCase):
    """A rule that fires on text holding no secret silently rewrites a task."""

    def test_env_var_reference_untouched(self):
        for t in ("const config = { apiKey: process.env.ANTHROPIC_API_KEY };",
                  "secret: ${MY_SECRET}",
                  "password: os.environ['PW']"):
            self.assertEqual(scrub(t), t, f"corrupted: {t!r}")

    def test_prose_untouched(self):
        for t in ("token: this-is-just-prose-about-lexers",
                  "from sk-learn-wrapper-module import thing",
                  "password: hunter"):
            self.assertEqual(scrub(t), t, f"corrupted: {t!r}")

    def test_separator_is_preserved(self):
        # Rewriting `:` to `=` breaks YAML and JSON structure.
        out = scrub("api_key: Ab3defGh1jklMn0pQr5t")
        self.assertIn(":", out)
        self.assertNotIn("api_key=", out)

    def test_empty_and_none(self):
        self.assertEqual(scrub(""), "")
        self.assertIsNone(scrub(None))


class TestNoCatastrophicBacktracking(unittest.TestCase):
    """Measured 14s on 80KB before the quantifiers were bounded -- roughly 40
    minutes on a 1MB blob, on the path everything leaving the box takes."""

    def _under(self, text, budget):
        t0 = time.time()
        scrub(text)
        took = time.time() - t0
        self.assertLess(took, budget, f"{len(text)} chars took {took:.2f}s")

    def test_dotted_chain(self):
        self._under("a." * 40000, 2.0)

    def test_repeated_begin_markers(self):
        self._under("-----BEGIN X PRIVATE KEY-----\n" * 2000, 2.0)

    def test_at_signs(self):
        self._under("a@" * 40000, 2.0)


class TestSensitivity(unittest.TestCase):
    def test_variants_are_caught(self):
        # A hyphen must not defeat the gate whose output "must never be sent to
        # a cloud endpoint".
        for t in ("Y-Prime study", "yprime", "Y Prime", "N C H F A portal",
                  "NCHFA", "NC Housing Finance Agency", "Tesoro pipeline"):
            self.assertEqual(sensitivity(t), "local-only", t)

    def test_unicode_variants(self):
        # The [^a-z0-9] strip removes fullwidth characters entirely, so without
        # an NFKC normalise first the gate is defeated by a keyboard mode.
        for t in ("\uff39-\uff30\uff52\uff49\uff4d\uff45", "\uff34\uff45\uff53\uff4f\uff52\uff4f",
                  "N.C.H.F.A.", "Te-so-ro"):
            self.assertEqual(sensitivity(t), "local-only", repr(t))

    def test_ordinary_work_is_shareable(self):
        for t in ("fix the linkify bug", "add a kanban column", ""):
            self.assertEqual(sensitivity(t), "shareable", t)

    def test_checked_before_scrubbing(self):
        # The point of checking raw text: redaction would hide that the task
        # concerns that work at all.
        self.assertEqual(sensitivity("Tesoro at 10.10.10.22"), "local-only")


if __name__ == "__main__":
    unittest.main()
