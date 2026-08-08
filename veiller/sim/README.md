# Simulator harnesses

Two ways to walk the Turma miniapp end to end without a phone, a pair of G2s,
or a hub — both driven by the Veiller miniapp simulator, which runs this
package's **built bundle** against the phone's real host and display pipeline.

| File | What it covers |
|---|---|
| `walkthrough.ts` | The glasses. 33 steps over sign-in, the home list, the session transcript and its live tail, history paging, the answer sheet, dictation, the actions/confirm menus, the spawn flow, settings, hub failure, backgrounding, the phone bridge and sign-out — printing the lens after each one. |
| `phone-tour.ts` | The phone companion: the WebView↔background bus (`turma:fetch`, storage, `turma:cmd`, the state broadcasts and chunked pull) and the markup the app's own `phoneHtml` renders from what the background sent. |
| `fake-hub.ts` | A Turma hub that speaks the real REST + `/live` + `/audio` contract but takes its cues from the test, so a question arrives, a turn streams, or the hub goes down on command. Every mutation it receives is recorded for assertions. |

Both exit non-zero on a finding, so they work as regression checks.

## Running them

The simulator lives in the Veiller monorepo (`sdk/miniapp-simulator`) — it
emulates the phone, not this miniapp. Keep a Veiller checkout beside the Turma
one, or point `VEILLER_REPO` at it. Its own deps install with
`bun install` in `sdk/miniapp-simulator`.

```bash
cd veiller
bun install
bun run build                        # the harnesses walk dist/, not src/

bun run sim/walkthrough.ts
bun run sim/walkthrough.ts --step 9  # stop after step 9
bun run sim/walkthrough.ts --verbose # mirror the miniapp's console

bun run sim/phone-tour.ts
bun run sim/phone-tour.ts --html     # dump the rendered phone markup
```

To walk a **released** bundle instead of this checkout's build — what people
actually installed — point `TURMA_BUNDLE` at the zip:

```bash
gh release download v0.6.45 --pattern 'turma-veiller-*.zip'
TURMA_BUNDLE=./turma-veiller-v0.6.45.zip bun run sim/walkthrough.ts
```

They are deliberately **not** wired into `veiller-ci.yml`: the simulator is in
a different private repo, which a PR runner has no token for. Run them locally
before changing anything the lens or the phone bus touches.

## Seeing it rather than reading it

The simulator's own control panel shows the lens live next to the phone page,
with buttons for the temple bar and the mic:

```bash
bun ../../Veiller/sdk/miniapp-simulator/src/cli.ts ./veiller
# → http://localhost:8770
```

## Two constraints worth knowing before you change rendering

- **Leading whitespace never reaches the glass.** The phone re-wraps every
  scene text element through its own `TextWrapper`, whose `trimLines` is on and
  not exposed to a miniapp, so an indent is stripped before the frame is drawn.
  `core/render.ts` marks a turn's first line and leaves continuations flush
  because of this (see `MARKER_GUTTER`).
- **The lens is 7 lines**, not the 10 the Even Hub build had
  (`core/layout.ts`): 288px at the G2's calibrated 40px line height. Anything
  that sizes a box against the display has to derive from `DISPLAY_LINES`, and
  `render.ts`'s `boxLineCount` is the one place the bottom box's height is
  decided — the display backend and the scroll math both read it.
