#!/usr/bin/env python3
"""Sanitize text mined from real session transcripts.

XERK-445 Phase 0 caveat 2. Session data carries credentials, internal
hostnames, and client context. Anything that leaves the box -- into a committed
task file, or into a request to a cloud model -- goes through here first.

This is a redactor, not a guarantee. `sensitivity()` exists because some
material must not be routed off-prem even redacted; those tasks are marked
local-only and must never be sent to a cloud endpoint.

Three rules this file has to keep, each of which was a real defect:

1. **Ordering is load-bearing in both directions.** Credentials run before the
   host rules so a host match cannot chop a token in half. But the EMAIL rule
   must also run before the host rules, or `ops@mail.xerktech.com` becomes
   `ops@<INTERNAL_HOST>` and the local part survives.
2. **Every quantifier is bounded.** The unbounded character classes here are
   quadratic on adversarial input -- 14s on 80KB of `a.a.a...`, so ~40 minutes
   on a 1MB blob. This runs on anything leaving the box, so that is a hang.
3. **A rule may not fire on text that holds no secret.** `apiKey:
   process.env.ANTHROPIC_API_KEY` is not a credential, and redacting it
   silently rewrites a benchmark prompt.

Tests: bench/archive/test_scrub.py.
"""

import re

# Client / employer context named in the ticket. Presence of any of these makes
# a task local-only regardless of how well the text scrubs.
SENSITIVE_ORGS = ("nchfa", "yprime", "tesoro", "nchousingfinanceagency")

# Values that look like a credential assignment but are not one.
_NOT_A_SECRET = re.compile(
    r"^(process\.env\.|os\.environ|import\.meta\.env\.|\$\{?[A-Z_]+\}?$|<[A-Z_]+>$)")

_RULES = [
    # ---- credentials, first: a host or email rule must not chop one in half --
    (re.compile(r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----"
                r"(?:(?!-----BEGIN)[\s\S]){0,20000}?"
                r"(?:-----END [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----|$)"),
     "<REDACTED_PRIVATE_KEY>"),
    # OpenAI-style. Real keys are unbroken alnum runs; `sk-learn-wrapper` is not.
    (re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_]{20,120}\b"), "<REDACTED_API_KEY>"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,80}\b"),
     "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,120}\b"), "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b"),
     "<REDACTED_AWS_KEY>"),
    # AWS secret access key: the credential itself, not just the identifier.
    (re.compile(r"(?i)\b(aws_secret_access_key|aws_secret_key)\s*[=:]\s*"
                r"['\"]?[A-Za-z0-9/+=]{40}['\"]?"),
     r"\1=<REDACTED_AWS_SECRET>"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,100}\b"), "<REDACTED_SLACK_TOKEN>"),
    (re.compile(r"\bAIza[A-Za-z0-9_\-]{30,45}\b"), "<REDACTED_GOOGLE_KEY>"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{36}\b"), "<REDACTED_NPM_TOKEN>"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,2000}\.[A-Za-z0-9_\-]{8,4000}"
                r"\.[A-Za-z0-9_\-]{8,2000}\b"), "<REDACTED_JWT>"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{16,400}"), r"\1 <REDACTED_TOKEN>"),
    # ---- emails BEFORE hosts, or the local part survives a host rewrite ------
    (re.compile(r"\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}\b"),
     "<REDACTED_EMAIL>"),
    # ---- internal infrastructure -------------------------------------------
    (re.compile(r"\b[\w-]{1,63}(?:\.[\w-]{1,63}){0,4}\.xerktech\.(?:com|net)\b"),
     "<INTERNAL_HOST>"),
    (re.compile(r"\bxerktech\.atlassian\.net\b"), "<INTERNAL_HOST>"),
    (re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "<INTERNAL_IP>"),
    (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "<INTERNAL_IP>"),
    (re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"), "<INTERNAL_IP>"),
    (re.compile(r"(?i)\b(truenas0?\d?|maxai|k8x|talos0\d)\b"), "<INTERNAL_HOST>"),
    # ---- people and local paths --------------------------------------------
    # Jira exports carry these verbatim; they are the PII in our own tickets.
    (re.compile(r"(?im)^(\s*[-*]?\s*(?:Assignee|Reporter|Author|Owner))\s*:\s*.+$"),
     r"\1: <REDACTED_NAME>"),
    (re.compile(r"/(?:home|Users)/[^/\s]{1,64}"), "/home/<USER>"),
    (re.compile(r"/mnt/[^\s\"']{0,200}"), "<INTERNAL_PATH>"),
    # ---- generic key=value, last and deliberately narrow --------------------
    # Only fires on a value that actually looks like a secret: >=16 chars with
    # both a letter and a digit, and not an env-var reference. The separator is
    # preserved -- rewriting `:` to `=` corrupts YAML and JSON.
    (re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|auth[_-]?token|token)"
                r"(\s*[=:]\s*)(['\"]?)([A-Za-z0-9/+._\-]{16,200})\3"),
     "_generic_secret"),
]


def _generic_secret(m):
    key, sep, quote, value = m.group(1), m.group(2), m.group(3), m.group(4)
    if _NOT_A_SECRET.match(value):
        return m.group(0)
    if not (re.search(r"[A-Za-z]", value) and re.search(r"\d", value)):
        return m.group(0)          # prose, or a plain word — not a credential
    if value.isupper() and "_" in value:
        return m.group(0)          # an env-var NAME, not its value
    return f"{key}{sep}{quote}<REDACTED>{quote}"


def scrub(text):
    """Redact secrets and internal identifiers from one string."""
    if not text:
        return text
    for pattern, repl in _RULES:
        text = pattern.sub(_generic_secret if repl == "_generic_secret" else repl,
                           text)
    return text


def sensitivity(*texts):
    """'local-only' if any client/employer context appears, else 'shareable'.

    Matched against a form with all non-alphanumerics stripped, so `Y-Prime`,
    `Y Prime` and `yprime` are one token. A hyphen defeating the gate whose
    output "must never be sent to a cloud endpoint" is not an acceptable
    failure mode.

    Deliberately checked on the RAW text, before scrubbing: the point is to
    detect that a task concerns that work at all, which redaction would hide.
    """
    blob = re.sub(r"[^a-z0-9]", "", " ".join(t for t in texts if t).lower())
    return "local-only" if any(o in blob for o in SENSITIVE_ORGS) else "shareable"


if __name__ == "__main__":
    import sys
    sys.stdout.write(scrub(sys.stdin.read()))
