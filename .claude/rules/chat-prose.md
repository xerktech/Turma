---
paths:
  - "turma/public/chat.js"
  - "turma/tests/chat.test.js"
  - "turma/tests/prose-parity.js"
  - "turma/tests/prose-parity.test.js"
  - "android/app/src/test/java/com/xerktech/turma/core/ProseParityTest.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/Prose.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/ProseTest.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/ChatItems.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/ChatItemsTest.kt"
  - "android/app/src/main/java/com/xerktech/turma/SafeSvgDecoder.kt"
  - "android/app/src/main/java/com/xerktech/turma/core/SvgGuard.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/SvgGuardTest.kt"
  - "android/app/src/test/java/com/xerktech/turma/SafeSvgDecoderTest.kt"
---

# Chat bubble prose — the `renderProse` markdown engine

Split out of `.claude/rules/turma-sessions.md` (the Sessions page + chat engine) to stay under the
40,000-char ceiling. This is the markdown renderer that turns a bubble's prose into HTML, shared
byte-for-byte between `chat.js` and Android's `Prose.kt` port.

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
    - **An inline code span's closer comes from the line's runs indexed BY LENGTH** (`renderInline`,
      `parseInline`), built once per line with a forward cursor per length. Scanning to the closer per
      opener was N^1.5 on a line of unclosed runs of distinct lengths (3.5 s at 1M chars).
  - **The raw-SVG pass scans only up to the LAST `</svg>`** (`renderSvgAndText`; Android stops at
    the first opener with no closer after it). Past it every line-start `<svg` retried its lazy body
    to the end of the text and failed — quadratic on a run of unclosed openers. Same matches.
  - **Android splits a paragraph around an image at RENDER time** (`splitImages`), not in the parse:
    the web's `<img>` is `display: block` inside inline content, so the tree keeps `Span.Image` inline
    and `ProseInline` breaks the line there, dropping the newline either side as other constructs do.
  - **Every SVG Android decodes passes `SafeSvgDecoder` (`core/SvgGuard.kt`), registered INSTEAD of
    Coil's `SvgDecoder.Factory`.** AndroidSVG expands DOCTYPE entities unbounded and a Coil decode is
    not cancelled on leaving the screen, so one agent-sent entity bomb pinned the CPU for the app's
    life. Any DOCTYPE/ENTITY is refused (alt text shows), and the root is found by WALKING the
    prolog (comments, PIs), never by searching for `<svg` — a `<svg` in a comment hid a DOCTYPE
    after it. It also sniffs past Coil's 1 KB / first-byte-`<` limit. Tests: `SvgGuardTest`.
  - **Android renders SVG with its own decoder (`SizedSvgDecoder`), never coil-svg's `SvgDecoder`**,
    to size it as a browser sizes an SVG `<img>`: no size → 300 × 150, each bitmap side ≥ 1 px (an
    extreme aspect rounded to 0 and failed), a declared zero width/height → an empty 0 × 0 drawable
    `ProseImage` lays out as nothing. Tests: `SafeSvgDecoderTest`.
    - **The drawable's intrinsic size is the SVG's own (CSS px), never its bitmap's.** `ProseImage`
      caps the box at it; a bitmap scaled up to the full-width placeholder made every SVG fill the
      bubble. The bitmap is device-density, bounded by the box width and a pixel ceiling.
    - **Every render goes through `SvgRenderGuard`'s `GuardedCanvas`, whose `save()` is the only hook
      AndroidSVG offers per element and per pattern tile.** It checks the thread's interrupt (Coil
      cancels via `runInterruptible`), a 5 s deadline and a step budget. Without it an image-free
      `<pattern>` of 0.01-unit tiles pinned a core for 11+ min past Back (XERK-2108).
    - **`save()` doesn't see clip work or a single native draw, so a cost walk over the PARSED tree
      runs first** (`SvgRenderGuard.Cost`): it follows every reference AndroidSVG does (`<use>`,
      clip-path, mask, markers, pattern fill/href, tref/textPath), memoised so it stays linear on
      an exponential fan-out. A 2.5 KB clip-path `<use>` fan-out never called `save()` and ran 4+ min.
      - Budgets are MEASURED, not guessed: native cost grows faster than size (a self-crossing clip
        outline is ~n², a wide stroke too), so the weights hold the worst accepted shape near 2 s.
        Re-measure before changing them.
      - What it can't price is refused: a stylesheet setting clip-path/mask/marker, and a clip-path
        inside pattern content (paid per tile, and the tile count is only known at render time).
    - **Embedded raster images go only through `SvgRenderGuard`.** AndroidSVG 1.4 decodes a base64
      `data:` `<image>` itself, at full size, on every draw, and asks the external resolver only
      when that check returns null — so the guard rewrites each PARSED `<image>` href (reflection)
      to a sentinel and resolves it: size read first, decoded once, every draw (pattern tile, `<use>`)
      counted against `SVG_EMBEDDED_MAX_PIXELS`, plus a render deadline; past it → alt text.
    - **Never go back to a text pre-scan of the SVG for data URIs**: each one lost to the parser (a
      mime past the scan's cap, a raw quote inside the payload that `Base64.decode` skips).
  - **A viewBox-only SVG `<img>` carries `width`/`height` attributes on the web** (`svgSizeAttrs`,
    XERK-2161): with no intrinsic size it laid out at 0 × 0 in a shrink-to-fit bubble or table cell.
    The width is the one reaching `.md-img`'s 420px max-height, so it fills the bubble at its ratio
    like Android's `svgFilledSize`. Never put `width: auto` back on `.md-svg` — it overrides them.
  - **That `<img>` is border-box, so the width attribute adds the border + padding
    on top of the content's width** (rollup XERK-2148): sized without them a 1:10 SVG stopped at
    294px. Android's `proseImageSize(inset =)` adds an SVG's 6dp padding the same way. Tests:
    `chat.test.js` "XERK-2148: a viewBox-only SVG reaches the 420px cap…", `ProseImageSizeTest`.
  - **Every data: SVG `<img>` is padded on a white backdrop, a markdown `![](data:image/svg+xml…)`
    too** (`.md-img[src^="data:image/svg+xml" i]`, rollup XERK-2148), as Android's `ProseImage`
    pads it; `svgSizeAttrs` assumes that padding. Tests: `chat.test.js` "…padded on a white backdrop…".
  - **Android decodes a `data:` URI by its DECLARED type** (`DataImage` + `DeclaredBitmapDecoder`,
    XERK-2161), as the browser does: SVG bytes behind `data:image/png` are broken, never sniffed.
    - **Never `runBlocking { loader.execute(…) }` in a Robolectric test**: Coil resumes on the
      paused main looper and it hangs forever (the Android CI job then times out). Drive the fetcher
      and decoder factories of `turmaImageComponents()` directly (`DataImageTest`).
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
    - **Kotlin spells JS's `.` out (`JS_DOT`)**: Java's `.` also refuses U+0085 NEL, so
      `## H<NEL>` was a heading on the web and prose on Android (XERK-2140).
    - **No `\d`, no `IGNORE_CASE` in a port**: a device's ICU reads `\d` as any Unicode digit,
      and Kotlin's IGNORE_CASE folds Unicode, so `<ſvg>` (U+017F) was an image on Android. Use
      `[0-9]` and spelled-out `[sS][vV][gG]`; the JVM unit tests cannot see the ICU half.
    - `FENCE_OPEN`'s `\s` is JavaScript's on both (Prose.kt / ChatItems.kt spell it as `JS_WS`):
      the JVM's `\s` is ASCII and a device's ICU one is Unicode, so neither runtime's own will do.
  - **Web ⇄ Android parity is CI-gated over one shared corpus** (XERK-2140). `prose-parity.js`
    generates a seeded corpus, reads each `renderProse` HTML back into a canonical tree, and
    writes `android/app/src/test/resources/prose-parity.json`; `ProseParityTest.kt` holds
    `parseProse` to it. `prose-parity.test.js` fails while the fixture is stale.
    - **After ANY `renderProse` change, run `node turma/tests/prose-parity.js` and commit the
      fixture** — then the Android test says whether `Prose.kt` still agrees.
    - The canonical tree folds ONLY the deliberate differences named in this file (list grouping,
      whitespace-only paragraphs, the SVG boundary newline). A new fold declares a difference
      deliberate: document it here or don't add it.
    - Widen the hunt locally with `PROSE_PARITY_CASES` / `PROSE_PARITY_SEED` / `PROSE_PARITY_LEN`
      (then regenerate at the defaults before committing).
  - **A lone UTF-16 surrogate inside an SVG block becomes U+FFFD on both** — `encodeURIComponent`
    throws on one, which took `renderProse` and the whole repaint down (XERK-2140).
  - **Line endings are normalised at EVERY entry point** — `renderProse` AND `renderInline` on the
    web, `parseProse` on Android (its only one). Every block rule ends
    `[ \t]*$`, so the `\r` that `split("\n")` leaves behind defeated all of them and a CRLF message
    rendered with NO markdown at all — reachable from any tool result echoing a Windows file, or
    from the native Windows agent. A lone `\r` becomes `\n` (CSS pre-wrap treats it as a segment
    break anyway). `renderInline` needs it for its own reason: the live bubble goes through that
    entry point, and un-normalised, an emphasis or code span would form ACROSS a lone `\r` — the
    thing `findEmphClose`'s newline bail exists to prevent. Leaving one entry point unnormalised
    also puts the web's two out of step with each other and with Android's one.
  - **`stripFraming` reads line ends exactly as the renderer does** (rollup XERK-1701): a lone CR
    ends a line, so `<tag>\r\r` is a tag line (dropped whole) plus a blank line (kept). U+2028,
    U+2029 and NEL end no line, so `<tag><U+2028>` is the operator's text, kept whole — never the tag
    dropped with the separator left behind (what the old `/m` regex did). That is why the tag regex
    has no `m` flag and Kotlin runs it as `matchEntire`. Tests: the line-ending cases beside the
    NBSP-fence case in `chat.test.js` and `ChatItemsTest.kt`.
  - A **wrapped bullet's continuation line belongs to its item** (GFM lazy continuation: more
    indented, not itself a construct). Without it a wrap ended the list, printed its own second
    line as a bare paragraph flush left, and started a new list underneath — 3% of the real
    corpus's list-bearing prose.
  - **Android flattens nested lists to depth-tagged rows** (`ProseBlock.ListBlock`) where the web
    nests real `<ul>`/`<ol>`s; Compose has no list primitive. Markers, depths and ordered numbering
    agree (verified against 3,000 real transcript blocks), but a marker switch at one depth opens a
    second list on the web and stays one flat block on Android. That grouping difference is
    deliberate and cosmetic — don't "fix" it by making the web stop distinguishing `<ul>` from `<ol>`.
    - Android's bullet markers are the browser's `<ul>` defaults — `•`, `◦`, then `▪` from depth 2
      down (`.md-list` sets no `list-style-type`); change both or neither.
  - **The live bubble uses `renderInline`, never `renderProse`** — `parsePaneLiveTurn` reflows the
    pane's hard-wrapped lines into ONE line, so a block pass has no line structure to read.
  - Every prose surface is styled as the same complete set — `.tr-msg`, `.thought-body`,
    `.compact-body`, `.away-body`, `.tool-plan` — for `a`, `.md-code`, `.md-code-inline`, `.md-img`,
    `.md-table` and the block classes. Left off one, a link falls back to the UA's blue/purple,
    unreadable on dark. `.compact-body`/`.away-body` must keep `white-space: pre-wrap` like their
    siblings, or a whole structured recap collapses into one wall of text.
