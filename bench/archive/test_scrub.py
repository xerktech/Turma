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

# A real PEM body line is 64 base64 characters. Fixtures must use that length:
# the rule discriminates key material from prose by RUN LENGTH, so a short
# stand-in tests a threshold the real data never exercises.
B64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGl1sQ2Tn0aBcd"


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
            f"-----BEGIN RSA PRIVATE KEY-----\n{B64}\n… (output truncated)", B64)

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

    def test_anthropic_key(self):
        # sk-ant keys are hyphenated, so an unbroken-alnum pattern misses them.
        # This is a corpus of Claude Code transcripts: it is the likeliest
        # format present, and it leaked until it had its own rule.
        key = "sk-ant-api03-" + "AbCdEfGh1234" * 4
        self.assert_gone(f"ANTHROPIC_API_KEY={key}", key, "sk-ant-api03")

    def test_other_vendor_tokens(self):
        for token in ("sk_live_" + "a" * 24, "sk_test_" + "b" * 24,
                      "glpat-" + "c" * 20, "hf_" + "d" * 24,
                      "xapp-1-A01234567-" + "e" * 16):
            self.assert_gone(f"secret is {token}", token)

    def test_azure_account_key(self):
        key = "A" * 60
        self.assert_gone(f"AccountKey={key};EndpointSuffix=core.windows.net", key)

    def test_url_basic_auth(self):
        # Assert on the marker, not just on the secret's absence: with a dotted
        # host the EMAIL rule removes `user:pass@host` incidentally, so a test
        # that only checks the secret is gone passes with this rule deleted.
        out = scrub("clone https://deploy:s3cr3tvalue@git.example.com/x.git")
        self.assertNotIn("s3cr3tvalue", out)
        self.assertIn("<REDACTED_URL_CREDS>", out)
        # A host with no dot is out of the email rule's reach entirely.
        out2 = scrub("psql postgres://admin:hunter2pass@localhost:5432/db")
        self.assertNotIn("hunter2pass", out2)

    def test_json_quoted_forms(self):
        # JSON is the dominant shape in this corpus -- tool results, settings
        # files, API bodies. The key's closing quote sits before the separator,
        # which the first version of the rule had no room for.
        self.assert_gone('{"password": "Zx9Qw8Er7Ty6Ui5Op4"}', "Zx9Qw8Er7Ty6Ui5Op4")
        self.assert_gone('{"api_key": "Ab3defGh1jklMn0pQr5t"}', "Ab3defGh1jklMn0pQr5t")
        self.assert_gone(
            '"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")

    def test_private_key_indented_in_yaml(self):
        # PEM inside a YAML block scalar: the body is indented past the few
        # whitespace characters the first fallback allowed, so it survived.
        self.assert_gone(
            f"key: |\n        -----BEGIN RSA PRIVATE KEY-----\n"
            f"        {B64}\n        {B64}", B64)

    def test_private_key_with_pem_headers(self):
        # An encrypted key puts Proc-Type/DEK-Info and a blank line before the
        # body; neither is base64-shaped, so the body survived.
        self.assert_gone(
            f"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n"
            f"DEK-Info: AES-128-CBC,ABC\n\n{B64}\n{B64}", B64)

    def test_key_body_on_the_headers_own_line(self):
        # The shape a key takes once its newlines are stripped: a flattened
        # JSON value or a single-line env var. Line-anchoring the body once
        # stopped redacting this while fixing the prose case.
        self.assert_gone(f"PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY----- {B64}", B64)

    def test_prose_starting_a_line_is_kept(self):
        # A long identifier at the start of a line is still prose. Anchoring on
        # line position instead of run length redacted this.
        out = scrub("-----BEGIN RSA PRIVATE KEY-----\n"
                    "  reproducibleBuildConfiguration: true\n")
        self.assertIn("reproducibleBuildConfiguration", out)

    def test_prose_after_bare_header_is_kept_in_every_shape(self):
        # The scanner replaced a regex that got this wrong four different ways.
        # Each of these destroyed a real sentence at some point.
        for text, keep in (
            ("-----BEGIN RSA PRIVATE KEY----- Note: rotate this key please, "
             "it is in the log", "rotate this key please"),
            ("-----BEGIN RSA PRIVATE KEY-----\n    apiKey: "
             "process.env.ANTHROPIC_API_KEY", "process.env.ANTHROPIC_API_KEY"),
            ("-----BEGIN RSA PRIVATE KEY-----\nhttps://github.com/x/y/pull/482 "
             "has the details", "has the details"),
            ("-----BEGIN RSA PRIVATE KEY-----\nNote: this file was committed "
             "by mistake, please rotate", "committed by mistake"),
        ):
            self.assertIn(keep, scrub(text), text[:60])

    def test_prefixed_credential_names(self):
        # `\b` does not exist after `_`, so anchoring the NAME there matched
        # bare `token` while missing every prefixed form -- measured at 873 of
        # 992 real credential assignments in the corpus surviving untouched.
        # Prefixes are what real config uses, so that was nearly all of them.
        for name in ("TURMA_TOKEN", "POSTGRES_PASSWORD", "VAULT_TOKEN",
                     "LITELLM_API_KEY", "db_password", "APP_SECRET",
                     "IMMICH_API_TOKEN", "MY-TOKEN", "token", "password"):
            self.assert_gone(f'{name}: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"',
                             "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")

    def test_prefixed_name_still_refuses_non_secrets(self):
        # Widening the name is only safe while the VALUE check bounds it.
        for t in ("MY_TOKEN: ${VAULT_TOKEN}",
                  "APP_SECRET: process.env.APP_SECRET",
                  "DB_PASSWORD: hunter"):
            self.assertEqual(scrub(t), t, t)

    def test_decorated_key_body_lines(self):
        # A key body rarely arrives bare: it comes inside a diff, a quoted
        # reply, a line-numbered file read or a JSON string. Any one of those
        # made the scan stop at the first body line and leak all the rest.
        for prefix in ("+ ", "> ", "12| ", '"'):
            self.assert_gone(
                f"-----BEGIN RSA PRIVATE KEY-----\n{prefix}{B64}\n"
                f"{prefix}{B64}\n{prefix}{B64}", B64)

    def test_truncated_key_with_escaped_newlines(self):
        # The complete-block case is redacted by the END path and never
        # exercises the literal-\n split at all, so pinning the escape logic
        # needs a TRUNCATED block.
        self.assert_gone(
            '{"private_key":"-----BEGIN PRIVATE KEY-----\\n' + B64 +
            '\\n' + B64, B64)

    def test_short_alnum_word_is_not_key_material(self):
        # _B64_MIN is the whole basis for telling a body line from an
        # identifier. Lowering it must fail, not just raising it.
        out = scrub("-----BEGIN RSA PRIVATE KEY-----\nabcdefgh is the marker")
        self.assertIn("abcdefgh", out)

    def test_key_inside_json_with_escaped_newlines(self):
        # A service-account key: the only residual shape measured in the real
        # corpus, 9 occurrences. The separator is a literal backslash-n, so a
        # scanner keyed on real newlines matched nothing and the body survived.
        self.assert_gone(
            '{"private_key":"-----BEGIN PRIVATE KEY-----\\n' + B64 +
            '\\n' + B64 + '\\n-----END PRIVATE KEY-----\\n"}', B64)

    def test_truncated_key_trailing_partial_line(self):
        # A truncated key ends mid-line, so the last run is shorter than a full
        # body line and was being left in clear.
        self.assert_gone(f"-----BEGIN RSA PRIVATE KEY-----\n{B64}\nc2gtcn",
                         "c2gtcn")

    def test_body_separator_variants(self):
        for text in (f"-----BEGIN RSA PRIVATE KEY-----\r\n{B64}\r\n{B64}",
                     f"-----BEGIN RSA PRIVATE KEY-----\n\n\n\n\n{B64}",
                     "-----BEGIN RSA PRIVATE KEY-----\n" + " " * 80 + B64):
            self.assert_gone(text, B64)

    def test_bare_header_in_prose_keeps_the_sentence(self):
        # The fallback must not eat prose. Long CamelCase identifiers are
        # exactly what follows a header in an engineering transcript.
        out = scrub("-----BEGIN PRIVATE KEY----- ConfigurationManagerFactory "
                    "reproduces this whenever InternationalizationHelper runs.")
        self.assertIn("ConfigurationManagerFactory", out)
        self.assertIn("InternationalizationHelper", out)

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

    def test_headerless_blocks_are_not_quadratic(self):
        # Searching for -----END----- to end-of-string made N headers with no
        # END rescan the whole tail apiece. The budget is tight on purpose: a
        # loose one passed with the bound removed.
        self._under(("-----BEGIN X PRIVATE KEY-----\n" + B64 + "\n") * 3000, 0.5)

    def test_newline_free_headers_are_not_quadratic(self):
        # The SEGMENT scan needs the same bound as the END search. With it
        # applied to only one of the two, 229KB took 10s and 671KB took 74s.
        self._under(("-----BEGIN X PRIVATE KEY-----" + "x" * 200) * 3000, 1.0)

    def test_indented_blank_lines(self):
        # 31s on 8KB before the scan replaced the regex, and a second hang in
        # the Jira-name rule where two adjacent `\s*` spanned newlines.
        self._under("-----BEGIN RSA PRIVATE KEY-----" + ("\n" + " " * 40) * 20000,
                    3.0)

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
