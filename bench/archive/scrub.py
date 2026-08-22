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
2. **Every quantifier is bounded, and the hard case is not a regex at all.**
   Unbounded character classes here are quadratic on adversarial input -- 14s on
   80KB of `a.a.a...`, so ~40 minutes on a 1MB blob. Two adjacent ``\\s*`` after a
   multiline ``^`` are worse, because ``\\s`` crosses newlines. And PEM blocks are
   matched by `_redact_private_keys()`, a scanner, after the regex form produced
   five defects in both directions. This runs on anything leaving the box, so a
   hang here is not a performance bug, it is an outage.
3. **A rule may not fire on text that holds no secret.** `apiKey:
   process.env.ANTHROPIC_API_KEY` is not a credential, and redacting it
   silently rewrites a benchmark prompt.

Tests: bench/archive/test_scrub.py.
"""

import re
import unicodedata

# Client / employer context named in the ticket. Presence of any of these makes
# a task local-only regardless of how well the text scrubs.
SENSITIVE_ORGS = ("nchfa", "yprime", "tesoro", "nchousingfinanceagency")

# Values that look like a credential assignment but are not one.
_NOT_A_SECRET = re.compile(
    r"^(process\.env\.|os\.environ|import\.meta\.env\.|\$\{?[A-Z_]+\}?$|<[A-Z_]+>$)")

_RULES = [
    # ---- credentials, first: a host or email rule must not chop one in half --
    # Private keys are handled by _redact_private_keys(), not by a rule here.
    # See that function for why.
    # Anthropic keys are hyphenated (`sk-ant-api03-...`), so an unbroken-alnum
    # pattern misses them entirely. This is a corpus of Claude Code transcripts:
    # it is the single most likely key format present, and it was leaking.
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,200}"), "<REDACTED_API_KEY>"),
    # OpenAI-style. Real keys are unbroken alnum runs; `sk-learn-wrapper` is not.
    (re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_]{20,120}\b"), "<REDACTED_API_KEY>"),
    (re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{16,100}\b"), "<REDACTED_API_KEY>"),
    (re.compile(r"\bglpat-[A-Za-z0-9_\-]{16,100}\b"), "<REDACTED_GITLAB_TOKEN>"),
    (re.compile(r"\bhf_[A-Za-z0-9]{20,60}\b"), "<REDACTED_HF_TOKEN>"),
    (re.compile(r"\bxapp-[0-9]-[A-Za-z0-9\-]{10,120}\b"), "<REDACTED_SLACK_TOKEN>"),
    (re.compile(r"(?i)\bAccountKey\s*=\s*[A-Za-z0-9+/=]{40,120}"),
     "AccountKey=<REDACTED_AZURE_KEY>"),
    # Credentials embedded in a URL: https://user:secret@host
    (re.compile(r"\b([a-zA-Z][\w+.-]{0,20}://)[^/\s:@]{1,64}:[^/\s:@]{1,128}@"),
     r"\1<REDACTED_URL_CREDS>@"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,80}\b"),
     "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,120}\b"), "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b"),
     "<REDACTED_AWS_KEY>"),
    # AWS secret access key: the credential itself, not just the identifier.
    (re.compile(r"(?i)\b(aws_secret_access_key|aws_secret_key)(['\"]?\s*[=:]\s*)"
                r"['\"]?[A-Za-z0-9/+=]{40}['\"]?"),
     r"\1\2<REDACTED_AWS_SECRET>"),
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
    # `[ \t]*`, never `\s*`: `\s` matches newlines, so two adjacent `\s*` after a
    # multiline `^` backtrack across the whole document -- measured as a hang on
    # 820KB of indented blank lines. Leading whitespace on a line cannot contain
    # a newline anyway.
    (re.compile(r"(?im)^([ \t]*[-*]?[ \t]*(?:Assignee|Reporter|Author|Owner))"
                r"[ \t]*:[ \t]*.+$"),
     r"\1: <REDACTED_NAME>"),
    (re.compile(r"/(?:home|Users)/[^/\s]{1,64}"), "/home/<USER>"),
    (re.compile(r"/mnt/[^\s\"']{0,200}"), "<INTERNAL_PATH>"),
    # ---- generic key=value, last and deliberately narrow --------------------
    # Only fires on a value that actually looks like a secret: >=16 chars with
    # both a letter and a digit, and not an env-var reference. The separator is
    # preserved -- rewriting `:` to `=` corrupts YAML and JSON.
    (re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|auth[_-]?token|token"
                r"|aws_secret_access_key)"
                r"(['\"]?\s*[=:]\s*)(['\"]?)([A-Za-z0-9/+._\-]{16,200})\3"),
     "_generic_secret"),
]


_PEM_BEGIN = re.compile(r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----")
_PEM_END = re.compile(r"-----END [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----")
_B64_LINE = re.compile(r"[A-Za-z0-9+/=]+\Z")
_PEM_HEADER = re.compile(r"(?:Proc-Type|DEK-Info):")
# A PEM body line is 64 base64 characters. The longest identifiers in an
# engineering transcript -- ConfigurationManagerFactory,
# reproducibleBuildConfiguration -- are around 30, so 40 separates them.
_B64_MIN = 40
_B64_TAIL_MIN = 4        # a truncated key ends mid-line
_MAX_BODY_LINES = 500
_MAX_BLOCK_CHARS = 20000


def _redact_private_keys(text):
    """Replace PEM private-key blocks with a marker.

    Deliberately a scanner and not a regular expression. Five separate defects
    came out of the regex this replaces, in both directions:

      * requiring a matching -----END----- missed output Claude Code truncated,
        which is most of it;
      * allowing "anything to end of string" instead swallowed the prose after a
        bare header, destroying two sentences of a real task prompt;
      * anchoring the body to line starts stopped redacting a key whose newlines
        had been stripped -- a flattened JSON value or a single-line env var;
      * accepting any `Word:` line as a PEM header destroyed ordinary prose,
        including `apiKey: process.env.ANTHROPIC_API_KEY`, which rule 3 in this
        module's docstring says must never be rewritten;
      * and the nested optional whitespace inside a bounded repeat backtracked
        cubically -- 31 seconds on 8KB of indented non-body, which is a hang on
        the path everything leaving the box takes.

    A left-to-right scan has none of those failure modes and is trivially
    linear. It costs more lines than the regex and is worth every one.
    """
    if not text or "PRIVATE KEY" not in text:
        return text

    out = []
    pos = 0
    while True:
        begin = _PEM_BEGIN.search(text, pos)
        if not begin:
            out.append(text[pos:])
            return "".join(out)
        out.append(text[pos:begin.start()])

        # A complete block ends at its own END marker, whatever the body holds
        # (short bodies and PGP armour included). Another BEGIN first means this
        # header's block was truncated.
        #
        # The END search is BOUNDED, by the next BEGIN and by _MAX_BLOCK_CHARS.
        # Searching to end-of-string made a document of N headers with no END
        # quadratic -- each header rescanned the whole tail -- which is a hang
        # on exactly the shape this function exists to handle.
        next_begin = _PEM_BEGIN.search(text, begin.end())
        limit = min(next_begin.start() if next_begin else len(text),
                    begin.end() + _MAX_BLOCK_CHARS)
        end = _PEM_END.search(text, begin.end(), limit)
        if end:
            out.append("<REDACTED_PRIVATE_KEY>")
            pos = end.end()
            continue

        # Truncated: consume forward while what follows still looks like key
        # material. Segments are split on real newlines AND on the literal \n
        # escape, which is how a service-account key rides inside JSON.
        cur = begin.end()
        consumed = cur
        lines = 0
        while lines < _MAX_BODY_LINES:
            seg_start = cur
            while seg_start < len(text) and text[seg_start] in " \t":
                seg_start += 1
            if text.startswith("\\n", seg_start):
                seg_start += 2
            elif seg_start < len(text) and text[seg_start] in "\r\n":
                seg_start += 1
                if text.startswith("\n", seg_start):   # CRLF
                    seg_start += 1
            while seg_start < len(text) and text[seg_start] in " \t":
                seg_start += 1

            seg_end = seg_start
            while seg_end < len(text) and text[seg_end] not in "\r\n":
                if text.startswith("\\n", seg_end):
                    break
                seg_end += 1
            seg = text[seg_start:seg_end].rstrip()

            if _PEM_HEADER.match(seg):
                consumed = cur = seg_start + len(seg)
                lines += 1
                continue
            if not seg:                                # blank line inside a key
                # Must make progress, or a trailing blank spins forever.
                if seg_start <= cur or seg_start >= len(text):
                    break
                cur = seg_start
                lines += 1
                continue
            if _B64_LINE.match(seg) and len(seg) >= _B64_MIN:
                consumed = cur = seg_start + len(seg)
                lines += 1
                continue
            # A short trailing base64 run is the last partial line of a
            # truncated key -- but only immediately after real body lines.
            if (consumed > begin.end() and _B64_LINE.match(seg)
                    and len(seg) >= _B64_TAIL_MIN):
                consumed = seg_start + len(seg)
            break

        out.append("<REDACTED_PRIVATE_KEY>")
        pos = consumed


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
    # Private keys first, for the same reason the credential rules lead: a host
    # or email rule firing inside a key body would split it, and half a
    # redacted key is a leaked key.
    text = _redact_private_keys(text)
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
    joined = unicodedata.normalize("NFKC", " ".join(t for t in texts if t)).lower()
    blob = re.sub(r"[^a-z0-9]", "", joined)
    return "local-only" if any(o in blob for o in SENSITIVE_ORGS) else "shareable"


if __name__ == "__main__":
    import sys
    sys.stdout.write(scrub(sys.stdin.read()))
