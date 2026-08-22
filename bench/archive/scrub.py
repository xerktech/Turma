#!/usr/bin/env python3
"""Sanitize text mined from real session transcripts.

XERK-445 Phase 0 caveat 2. Session data carries credentials, internal
hostnames, and client context. Anything that leaves the box -- into a committed
task file, or into a request to a cloud model -- goes through here first.

This is a redactor, not a guarantee. `sensitivity()` exists because some
material must not be routed off-prem even redacted; those tasks are marked
local-only and the runner refuses to send them to a cloud endpoint.
"""

import re

# Client / employer context named in the ticket. Presence of any of these makes
# a task local-only regardless of how well the text scrubs.
SENSITIVE_ORGS = ("nchfa", "yprime", "tesoro")

_RULES = [
    # credentials first -- these must never survive, so they run before the
    # host rules that might otherwise chop a token in half and hide it.
    (re.compile(r"\b(sk-[A-Za-z0-9_\-]{16,})"), "<REDACTED_API_KEY>"),
    (re.compile(r"\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
     "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<REDACTED_AWS_KEY>"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
     "<REDACTED_JWT>"),
    (re.compile(r"(?i)\b(bearer|authorization:\s*bearer)\s+[A-Za-z0-9._\-]{16,}"),
     r"\1 <REDACTED_TOKEN>"),
    (re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|token)\s*[=:]\s*['\"]?[A-Za-z0-9/+._\-]{12,}['\"]?"),
     r"\1=<REDACTED>"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
                re.S), "<REDACTED_PRIVATE_KEY>"),
    # internal infrastructure
    (re.compile(r"\b[\w.-]+\.xerktech\.com\b"), "<INTERNAL_HOST>"),
    (re.compile(r"\b10\.10\.10\.\d{1,3}\b"), "<INTERNAL_IP>"),
    (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "<INTERNAL_IP>"),
    (re.compile(r"(?i)\b(truenas0?\d?|maxai|k8x|talos0\d)\b"), "<INTERNAL_HOST>"),
    # people
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"), "<REDACTED_EMAIL>"),
    (re.compile(r"/(?:home|Users)/[^/\s]+"), "/home/<USER>"),
]


def scrub(text):
    """Redact secrets and internal identifiers from one string."""
    if not text:
        return text
    for pattern, repl in _RULES:
        text = pattern.sub(repl, text)
    return text


def sensitivity(*texts):
    """'local-only' if any client/employer context appears, else 'shareable'.

    Deliberately checked on the RAW text, before scrubbing: the point is to
    detect that a task concerns that work at all, which redaction would hide.
    """
    blob = " ".join(t for t in texts if t).lower()
    for org in SENSITIVE_ORGS:
        if org in blob:
            return "local-only"
    return "shareable"


if __name__ == "__main__":
    import sys
    sys.stdout.write(scrub(sys.stdin.read()))
