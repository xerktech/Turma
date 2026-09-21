---
paths:
  - "turma/public/chat.js"
  - "glasses/src/vendor/chat.cjs"
  - "turma/tests/chat.test.js"
  - "android/app/src/main/java/com/xerktech/turma/core/Prose.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/ProseTest.kt"
---

# Chat bubble prose — the `renderProse` markdown engine

Split out of `.claude/rules/turma-sessions.md` (the Sessions page + chat engine) to stay under the
40,000-char ceiling. This is the markdown renderer that turns a bubble's prose into HTML, shared
byte-for-byte between `chat.js` (vendored into glasses) and Android's `Prose.kt` port.

- Bubble prose via `renderProse`: fenced ` ``` ` → `<pre class="md-code">` (language chip); GFM
  tables → real `<table>`s; ATX headings / `-`,`*`,`+` + `1.` lists / `>` quotes / `---` rules →
  real elements (`renderBlocks`); `**bold**`/`*italic*`/`~~strike~~` (`renderEmph`); inline
  ` `code` ` → `<code class="md-code-inline">`; else linkified.
  - Passes nest outward-in — fence, raw SVG, table, **block**, inline code, **emphasis**, link — so
    code is never linkified or emphasised; an inline code span and an emphasis span each never cross
    a line break; an unterminated fence renders as code.
  - **`esc()` is called ONLY at the innermost layer** (`linkify`, `codeSpan`). Every pass above
    slices RAW text, hands slices down, and concatenates only literal tag strings it wrote itself.
    **Never regex over generated HTML** — it holds `href="…/a_b_c"` and `&quot;`, so a naive rule
    matches inside an attribute. A new pass obeys this or it is an injection hole.
  - **A plain paragraph emits NOTHING of its own** — no `<p>`. The containers are
    `white-space: pre-wrap`, so paragraphs already break correctly and a `<p>` would double every
    blank line; construct-free text stays byte-identical to `renderInline`. For the same reason a
    construct CONSUMES the newlines around it, or a stray `\n` prints on top of its margin.
  - `_`/`__` are deliberately NOT emphasis delimiters: this corpus is `snake_case`, `__init__` and
    `file_path` throughout, and nothing Claude writes needs them. Don't add them back.
  - Tables run BEFORE the block pass, so a `|---|---|` delimiter row is never read as a rule while a
    bare `---` (no pipe) correctly is.
  - **Every pass must be LINEAR in the text.** `repaint()` re-renders the whole buffer on each ~1s
    tail frame, and a 100k-char block is inside the wire's own `BLOCK_TEXT_CHARS` cap, so a
    quadratic pass is a seconds-long main-thread freeze an agent can trigger. What keeps it linear:
    the per-line `noClose` memo in `findEmphClose` (N unclosed openers cost ONE scan, not N) and
    `EMPH_MAX_DEPTH`. `trailingMarkerStart` peels markers backwards for the same reason — the
    obvious `/(?:\[\w+\])+$/` is unanchored on the left and retries from every `[`.
    - **The memo is keyed on where the ENTRY-INDEPENDENT scan starts, not on `from`.** `from` can
      land INSIDE a delimiter run, and the partial run it measures there is a candidate no other
      scan of that line sees — so that one is tested first, before the memo is consulted, and the
      memo covers only the part of the scan that depends on the index alone. That is what makes
      "a failure here means a failure for every later opener" true rather than merely plausible.
      Measured output-neutral (memo on vs off) over 550k renders + the whole real corpus. Keying on
      `from` has not been shown to change output — the entry-dependent candidate can only ever
      return `from`, which the caller's empty-span check rejects — so treat this as belt and
      braces, not as a bug fix, and do not "simplify" it away on the strength of that.
    - **The memo is the ONLY thing keeping emphasis linear**, so it needs a shape whose closer
      scans FAIL to catch its removal: `"*a ".repeat(33333)` is 5ms with it and 16.5s without,
      while every shape that FINDS its closer costs nothing either way. Both ports' perf tests
      carry the spaced shapes for exactly that reason. Tests: `renderProse: emphasis and markers
      stay linear on pathological input` (`chat.test.js`), its `ProseTest.kt` twin.
    - **Capping the run count was tried and REVERTED.** It bought nothing the memo doesn't already
      give, and it changed output — a saturated count made `m === len` true for a longer run and
      resumed the scan INSIDE one, fabricating emphasis on input that had none. Don't re-add it.
  - **A rule line is a SCAN (`isRuleLine`), never `/(?:-[ \t]*){3,}/`.** That regex is linear in V8
    but `java.util.regex` recurses once per iteration of a quantified GROUP, so the Android port of
    it threw an **uncatchable `StackOverflowError`** out of `parseProse` inside a Composable (an
    `Error`, so the `catch (e: Exception)` there never saw it) on one long line of dashes. Any
    JS→Kotlin regex port carrying a quantified group needs that check.
  - **Android uses `isJsSpace`/`isJsBlank`, not `Character.isWhitespace`/`isBlank()`** — Java's set
    omits U+00A0 and U+FEFF and adds U+001C..U+001F, so the platform's answer made the same message
    render differently on the two clients. For the same family of reason Kotlin uses `matchEntire`,
    not `find`, on the fully-anchored line patterns: **Java's `$` also matches BEFORE a final line
    terminator and JavaScript's does not.** Pinned by the U+2028/U+2029 cases in `chat.test.js` +
    `ProseTest.kt` — CR alone cannot pin it, because the normalisation below already handles CR.
    - **Two exotic-whitespace classes still differ and are knowingly left.** U+0085 NEL is a Java
      line terminator that JavaScript's `.` matches, so `## H<NEL>` is a heading on the web and
      prose on Android; and `FENCE_OPEN`'s `\s` is each runtime's own (NBSP, BOM and friends open
      a fence on one side and not the other, in both directions). Neither appears anywhere in the
      real corpus. Don't assert either answer in a test — that codifies the disagreement.
  - **Line endings are normalised at EVERY entry point** — `renderProse` AND `renderInline` on the
    web, `parseProse` on Android (its only one). Every block rule ends
    `[ \t]*$`, so the `\r` that `split("\n")` leaves behind defeated all of them and a CRLF message
    rendered with NO markdown at all — reachable from any tool result echoing a Windows file, or
    from the native Windows agent. A lone `\r` becomes `\n` (CSS pre-wrap treats it as a segment
    break anyway). `renderInline` needs it for its own reason: the live bubble goes through that
    entry point, and un-normalised, an emphasis or code span would form ACROSS a lone `\r` — the
    thing `findEmphClose`'s newline bail exists to prevent. Leaving one entry point unnormalised
    also puts the web's two out of step with each other and with Android's one.
  - A **wrapped bullet's continuation line belongs to its item** (GFM lazy continuation: more
    indented, not itself a construct). Without it a wrap ended the list, printed its own second
    line as a bare paragraph flush left, and started a new list underneath — 3% of the real
    corpus's list-bearing prose.
  - **Android flattens nested lists to depth-tagged rows** (`ProseBlock.ListBlock`) where the web
    nests real `<ul>`/`<ol>`s; Compose has no list primitive. Markers, depths and ordered numbering
    agree (verified against 3,000 real transcript blocks), but a marker switch at one depth opens a
    second list on the web and stays one flat block on Android. That grouping difference is
    deliberate and cosmetic — don't "fix" it by making the web stop distinguishing `<ul>` from `<ol>`.
  - **The live bubble uses `renderInline`, never `renderProse`** — `parsePaneLiveTurn` reflows the
    pane's hard-wrapped lines into ONE line, so a block pass has no line structure to read.
  - Every prose surface is styled as the same complete set — `.tr-msg`, `.thought-body`,
    `.compact-body`, `.away-body`, `.tool-plan` — for `a`, `.md-code`, `.md-code-inline`, `.md-img`,
    `.md-table` and the block classes. Left off one, a link falls back to the UA's blue/purple,
    unreadable on dark. `.compact-body`/`.away-body` must keep `white-space: pre-wrap` like their
    siblings, or a whole structured recap collapses into one wall of text.
