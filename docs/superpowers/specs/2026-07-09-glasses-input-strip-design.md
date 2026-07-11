# Glasses UI: persistent bottom bar (input box + question sheet)

## Context

The Turma glasses client (`glasses/`) works end to end, and we're now refining
the session screen. Three problems today:

1. There's no persistent input affordance — dictating a reply goes through a
   separate full-screen "reply" screen, and answering a question goes through a
   separate full-screen "question" screen.
2. The session-name header eats the top line for little value.
3. Transcript scrolling jumps a **full page** per gesture (`app.ts` moves the
   offset by `SESSION_CONTENT_AREA` ≈ 9 lines), which feels jumpy.

The sibling ClaudeHUD app solves this with a persistent bottom **input strip**
plus bottom-anchored **sheets** for questions. We're porting that model, adapted
to our architecture (polling, not streaming; the question data already arrives
in the agent heartbeat as `session.question` + `session.questionOptions`).

Goal: a persistent bordered box at the bottom of the session screen that is the
dictation target by default, and that a pending `AskUserQuestion` takes over —
the question text fills and grows the box, its options are scrollable and
selectable inline. Remove the header line; make transcript scrolling smooth
(~2 lines/gesture).

Non-goals: any hub/agent change (the data is already there), the home screen,
the spawn flow's own prompt dictation, confirm dialogs, and the phone/web UI.

## Architecture change: a screen model, not just lines

Today `render(state)` returns `string[]` and `GlassesDisplay.render(lines)`
paints one full-canvas text container. To draw a real bordered box we generalize
the render output to a small discriminated **screen model**:

```ts
type ScreenModel =
  | { type: "lines"; lines: string[] }          // every screen except session
  | {
      type: "session";
      transcriptLines: string[];                 // already wrapped + windowed
      bottom: BottomModel;                       // input box OR question sheet
    };

type BottomModel =
  | { mode: "input"; body: string; status: string; focused: boolean }
  | {
      mode: "sheet";
      titleLines: string[];                      // wrapped question text
      options: string[];                         // option labels (+ "Dictate answer…")
      selected: number;                          // highlighted option
      focused: boolean;
      status: string;
    };
```

- `render(state): ScreenModel`. Non-session screens return `{type:"lines"}`
  exactly as today (their arrays are unchanged), so only the session screen and
  the display backends change.
- **`display/index.ts`**: `GlassesDisplay.render(model: ScreenModel)` (was
  `render(lines: string[])`).
- **`display/evenhub.ts`**: for `lines`, the current single-container path
  (`textContainerUpgrade`, 120ms debounce). For `session`, three containers —
  the transcript (top), the bordered input/sheet box (bottom), and the status
  corner — built via `rebuildPageContainer` when the layout structure changes
  (screen enter/leave, box height change, input↔sheet mode change) and
  `textContainerUpgrade` for text-only updates within a container. Exactly one
  container keeps `isEventCapture: 1` (a full-canvas transparent overlay, as
  ClaudeHUD does) so gesture routing stays in app code.
- **`display/dom.ts`** (dev backend): render `session` by stacking the
  transcript, a divider line, and the box body/options in the `<pre>`, so the
  DOM dev path stays usable without the SDK.

A new **`src/input-box.ts`** owns the box geometry and body text, ported from
ClaudeHUD's `input-strip.ts`: bottom-anchored, min 1 line, grows in line steps
with wrapped content, caps at half-canvas (144px). Pure functions, unit-tested.

## The bottom bar: two modes

The bottom bordered box renders one of two modes, chosen purely from state:

- **input** (default): the dictation target. Body is the draft text, or a
  placeholder (`> Tap to dictate…` when focused, blank when not). While the mic
  is live it shows `> Listening…` / `> Processing…`. Grows with the draft text.
- **sheet** (whenever `session.question` is set): the question text fills and
  grows the box (wrapped, up to the half-canvas cap, scrollable), with the
  option labels from `session.questionOptions` listed below, plus a trailing
  `Dictate answer…` row. The highlighted option is marked. This replaces the
  input box while the question is pending and removes the separate full-screen
  question screen.

The status corner (top-right of the box) shows a short static label derived from
`liveState`: `Working` / `Waiting` / `Idle` / `Error`, or `[REC]` / `[…]` /
`[!]` while dictating (mic state wins). No animated spinner (it would mean a
constant BLE repaint loop while a session works); can be added later.

## Focus & gesture model

Session-screen state gains `focus: "transcript" | "bottom"` and, for the sheet,
a `selected` option index. Four gestures (`tap`, `doubleTap`, `scrollUp`,
`scrollDown`) map as:

**Transcript focus (default):**
- scroll up/down → move transcript by `SESSION_SCROLL_STEP = 2` lines
  (clamped `[0, total - visible]`).
- tap → if scrolled up (`offset > 0`), snap to the newest (`offset = 0`); else
  set `focus = "bottom"`.
- double-tap → back to the session list (home).

**Bottom focus — sheet mode (question pending):**
- scroll up/down → move `selected` through the option list; a long question +
  option list scrolls smoothly within the box.
- tap → select the highlighted option → `sendInput(host, id, String(selected+1))`
  (digit; the agent appends Enter) → flash `✓ queued`, or, on the
  `Dictate answer…` row, switch the box to input mode and start dictation.
- double-tap → open the actions menu.

**Bottom focus — input mode (no question):**
- tap → start / stop dictation (via the existing `HubAudioDictation`; the
  transcript appends to the box body with a joining space, like ClaudeHUD).
- scroll → scroll within a tall box; at the top/bottom edge, hand focus back to
  the transcript (empty box hands back immediately).
- double-tap → open the actions menu.

**Actions menu** (the existing full-screen list, made context-sensitive):
- always: `Restart`, `Kill`, `Delete`, `Back`
- when the input box has draft text: prepend `Send`, `Clear`
- when a question is pending: include `Dictate answer…`
- `Kill` / `Delete` route through the existing confirm dialog unchanged.
- `Send` → `sendInput` the draft, clear the box optimistically, flash `✓ queued`.
  `Clear` → wipe the box.

When a question appears while the user is in input focus, focus drops to the
transcript (so the new sheet isn't accidentally acted on) — mirrors ClaudeHUD.

## Header removal & scroll

- The session screen no longer renders the `device·label` header line; the
  transcript container starts at the top of the canvas. `SESSION_CONTENT_AREA`
  grows by one line accordingly.
- `SESSION_SCROLL_STEP = 2`. The current full-page step in `app.ts` `onSession`
  (`offset ± SESSION_CONTENT_AREA`) is replaced by `offset ± 2`. History-fetch
  triggering (scroll past the known top) and the pending-overlay behavior are
  preserved.

## Files

- `glasses/src/render.ts` — return `ScreenModel`; session layout (drop header,
  build transcript window + bottom model); keep other screens as `lines`.
- `glasses/src/input-box.ts` — **new**: box geometry + body/sheet text (ported
  from ClaudeHUD `input-strip.ts` + `prompt-sheet.ts`), pure + tested.
- `glasses/src/display/index.ts` — `render(model: ScreenModel)` interface.
- `glasses/src/display/evenhub.ts` — multi-container session layout; single
  container for `lines`.
- `glasses/src/display/dom.ts` — stacked session render for dev.
- `glasses/src/app.ts` — session `focus` + `selected` state, 2-line scroll,
  tap/double-tap/scroll dispatch per focus/mode, dictation-in-box, context
  actions menu. The session flow no longer routes to the separate reply or
  question screens. The **question screen is removed** (nothing else used it).
  The **reply screen stays** because the spawn flow (`newPrompt`) still dictates
  an initial prompt through it — only the session→reply path is removed.
- `glasses/src/sessions.ts` / `constants` — `SESSION_SCROLL_STEP`, status label
  helper if not already derivable from `liveState`.
- Tests: `render.test.ts` (session model per mode/focus), `input-box.test.ts`
  (geometry/body/sheet), `app.test.ts` (focus transitions, 2-line scroll,
  option select → sendInput digit, dictation-in-box, send/clear, question takes
  over the bottom, snap-to-tail), display backends minimally.

## Verification

- `npm test` + `npm run typecheck` + `npm run build` in `glasses/`.
- `npm run dev` (DOM backend) + `mock-hub` (has a session with a pending
  question + options): walk transcript scroll (2 lines), tap into the bottom,
  see the question sheet, scroll options, select one, and dictate/send in input
  mode.
- On-hardware (added to `glasses/README.md` QA checklist): the bordered box
  renders and grows; a pending question fills/grows/scrolls the box and an option
  is selectable; dictation into the box works; transcript scroll feels smooth.

## Risks

- Multi-container BLE pacing: keep `rebuildPageContainer` for structural changes
  only, `textContainerUpgrade` (debounced 120ms) for text; respect the 12-
  container / one-event-capture rules and the 2000-char per-container cap.
- The `render(lines)` → `render(model)` interface change touches both display
  backends and every `display.render(...)` call site — contained, but must be
  updated together.
