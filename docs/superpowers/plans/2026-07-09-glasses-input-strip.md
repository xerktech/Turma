# Glasses Persistent Bottom Bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the glasses session screen a persistent bordered bottom bar that is the dictation target by default and that a pending `AskUserQuestion` takes over (question text grows the bar; options scrollable + selectable inline). Remove the header line; make transcript scrolling ~2 lines/gesture.

**Architecture:** Generalize the renderer from `render(state) → string[]` to `render(state) → ScreenModel` (a discriminated union). Every screen except the session screen returns `{type:"lines"}` unchanged. The session screen returns `{type:"session", transcriptLines, bottom}` where `bottom` is an input box or a question sheet. The Even Hub backend builds three containers for `session` (transcript + bordered box + status corner) and one for `lines`; the DOM dev backend stacks them. Session-screen interaction adopts ClaudeHUD's transcript-vs-bottom focus model.

**Tech Stack:** TypeScript (strict), Vite, Vitest, `@evenrealities/even_hub_sdk` (structural typing only, dynamically imported in `evenhub.ts`). Screen behaviour is ported from the ClaudeHUD plugin's `input-strip`/`prompt-sheet`/`chat`/`text-wrap` screens (a separate, private project — not required to build or work on this repo).

## Global Constraints

- No hub/agent changes — the question data already arrives as `session.question` (string|null) and `session.questionOptions` (string[]); dictation uses the existing `HubAudioDictation`; sending uses the existing `hub-client.sendInput(host, id, text)`.
- Canvas 576×288, 4-bit greyscale. `DISPLAY_LINES = 10`, `LINE_WIDTH_PX = 560`, line height 27px. Bottom box caps at half-canvas (144px). Max 12 containers/page, exactly one `isEventCapture: 1` per page, 2000-char cap per `textContainerUpgrade`, structural changes via `rebuildPageContainer`, text-only via `textContainerUpgrade` debounced 120ms (`RENDER_DEBOUNCE_MS`).
- Options are answered by sending the 1-based digit as input text: `sendInput(host, id, String(index + 1))` — the agent appends Enter.
- `render()` stays a pure function of `AppState` (no I/O, no `Date.now`); time is injected. All new logic unit-tested; DOM backend may be lightly tested.
- Scope: session screen + display layer only. The **question screen is removed** (nothing else uses it). The **reply screen stays** — the spawn/`newPrompt` flow still dictates through it (`reply.target.kind !== "session"`); only the session→reply path is removed.
- Commit after each task. Run `npm test`, `npm run typecheck`, `npm run build` in `glasses/` before each commit; all must pass.

---

### Task 1: `input-box.ts` — pure geometry + body/sheet text

**Files:**
- Create: `glasses/src/input-box.ts`
- Test: `glasses/src/input-box.test.ts`

Port the pure helpers from ClaudeHUD `plugin/src/screens/input-strip.ts` (box geometry, body text, status label) and the sheet-body idea from `prompt-sheet.ts`, adapted to our units (`DISPLAY_LINES`, `LINE_WIDTH_PX`, half-canvas cap = 5 lines of the 10). This task is pure data → strings; no SDK, no state machine.

**Interfaces — Produces:**
```ts
export type MicState = "idle" | "recording" | "finalising" | "error";

// How many text lines the bottom box occupies, given its wrapped content.
// Min 1, grows with content, capped at BOTTOM_MAX_LINES (5 = half of 10).
export const BOTTOM_MAX_LINES = 5;
export function bottomBoxLines(contentLines: string[]): number; // clamp(len,1,5)

// Input-mode body: the visible (windowed) text for the box, given the draft
// text, focus, mic state, and a scroll offset within a tall box.
export function inputBoxBody(opts: {
  text: string; focused: boolean; mic: MicState; viewOffset: number;
}): string[]; // wrapped, windowed to <= BOTTOM_MAX_LINES

// Sheet-mode body: wrapped question title lines + numbered option rows +
// a trailing "Dictate answer…" row, windowed around `selected` to fit.
export function sheetBody(opts: {
  question: string; options: string[]; selected: number;
}): string[];

// Short right-corner status label from live state + mic.
export function statusLabel(opts: {
  mic: MicState; live: "working" | "waiting" | "idle" | "stopped" | "error";
}): string; // "[REC]"/"[…]"/"[!]" if mic active, else "Working"/"Waiting"/…
```

- `inputBoxBody`: mic `recording` → `["> Listening…"]`; `finalising` → `["> Processing…"]`; empty text → `focused ? ["> Tap to dictate…"] : [""]`; else wrap `text` at `LINE_WIDTH_PX` via `wrapText`, prefix first visible line with `> ` (focused) / `  ` (not), window the last `BOTTOM_MAX_LINES` minus `viewOffset` (clamped).
- `sheetBody`: wrap `question`; then rows `1. <opt>` … plus `<n>. Dictate answer…`; mark the `selected` row with a leading `>`; window so the selected row is visible within `BOTTOM_MAX_LINES`.
- `statusLabel`: mic wins (`recording`→`[REC]`, `finalising`→`[…]`, `error`→`[!]`); else map live state (`working`→`Working`, `waiting`→`Waiting`, `idle`→`Idle`, `stopped`→`Stopped`, `error`→`Error`).

- [ ] **Step 1: Write failing tests** in `input-box.test.ts` covering: `bottomBoxLines` clamps to [1,5]; `inputBoxBody` for each mic state, empty focused/unfocused, and a long text windowed to ≤5 lines with the `> ` prefix; `sheetBody` wraps the question, numbers options, appends "Dictate answer…", marks `selected`, and windows a long list so `selected` stays visible; `statusLabel` mic-wins and each live mapping.
- [ ] **Step 2: Run** `npm test -- input-box` → FAIL (module missing).
- [ ] **Step 3: Implement** `input-box.ts` (import `wrapText` from `./text-wrap.ts`, constants from `./render.ts` or a shared constants module — if `LINE_WIDTH_PX`/`DISPLAY_LINES` currently live in `render.ts`, import them from there).
- [ ] **Step 4: Run** `npm test -- input-box` → PASS.
- [ ] **Step 5:** `npm run typecheck` → clean. **Commit** `glasses: input-box geometry + body/sheet/status helpers`.

---

### Task 2: `render.ts` — ScreenModel + session layout, drop header, scroll step

**Files:**
- Modify: `glasses/src/render.ts`
- Modify: `glasses/src/render.test.ts`

**Interfaces — Consumes:** Task 1 (`inputBoxBody`, `sheetBody`, `statusLabel`, `MicState`, `BOTTOM_MAX_LINES`).
**Produces:**
```ts
export const SESSION_SCROLL_STEP = 2;

export type BottomModel =
  | { mode: "input"; lines: string[]; status: string; focused: boolean }
  | { mode: "sheet"; lines: string[]; status: string; focused: boolean; options: string[]; selected: number };

export type ScreenModel =
  | { type: "lines"; lines: string[] }
  | { type: "session"; transcriptLines: string[]; bottom: BottomModel };

export function render(state: AppState): ScreenModel; // was: string[]
```

- Every non-session branch of `render` wraps its existing `string[]` as `{type:"lines", lines}`. Add a small helper `linesModel(lines): ScreenModel`.
- `renderSession`: **drop the header line**. Build `transcriptLines = sessionContentLines(...)` windowed by `state.session.offset` against a transcript area = `DISPLAY_LINES - bottomBoxLines(...)`. Build `bottom` from the session's live state + focus + (dictation draft OR pending question):
  - If `findSessionLocal(...).session?.question` is set → `{mode:"sheet", lines: sheetBody({question, options: questionOptions, selected}), options, selected, status: statusLabel(...), focused: focus==="bottom"}`.
  - Else → `{mode:"input", lines: inputBoxBody({text: draft, focused: focus==="bottom", mic, viewOffset}), status: statusLabel(...), focused: focus==="bottom"}`.
  - `mic`, `draft`, `focus`, `selected`, `viewOffset` come from new `AppState.session` fields added in Task 4 — for Task 2, thread them through with sensible defaults so `render` compiles and is testable from fixtures (define the extended `SessionScreenState` here or in app.ts and import). Keep `render` pure.
- Transcript windowing math stays the same (bottom-anchored, `offset` from newest), just against the new area height.

- [ ] **Step 1: Update/add failing render tests:** session fixture with no question → `{type:"session"}`, `transcriptLines` has NO header, `bottom.mode==="input"`; fixture with a pending question → `bottom.mode==="sheet"` with numbered options + "Dictate answer…"; a `lines`-type screen (home) still returns `{type:"lines"}`. Assert `SESSION_SCROLL_STEP === 2`.
- [ ] **Step 2: Run** `npm test -- render` → FAIL.
- [ ] **Step 3: Implement** the `ScreenModel` return + `renderSession` rewrite; wrap other screens in `linesModel`.
- [ ] **Step 4: Run** `npm test -- render` → PASS (note: app.ts + display still expect `string[]` — they're updated in Tasks 3–6; `npm run typecheck` will fail until then, which is expected mid-plan. Do NOT run the full build here).
- [ ] **Step 5: Commit** `glasses: render returns a ScreenModel; session layout w/ bottom bar, no header`.

---

### Task 3: display backends — `render(model)`

**Files:**
- Modify: `glasses/src/display/index.ts`, `glasses/src/display/dom.ts`, `glasses/src/display/evenhub.ts`
- Modify: `glasses/src/display/evenhub.test.ts` (+ dom test if present)

**Interfaces — Consumes:** Task 2 (`ScreenModel`).
**Produces:** `GlassesDisplay.render(model: ScreenModel): void`.

- `index.ts`: change `render(lines: string[])` → `render(model: ScreenModel)`.
- `dom.ts`: for `{type:"lines"}` → `el.textContent = lines.join("\n")` (as today). For `{type:"session"}` → stack `transcriptLines`, a divider `"─".repeat(40)` with the `status` right-aligned, then `bottom.lines`. One string into the `<pre>`.
- `evenhub.ts`: for `{type:"lines"}` → the current single-container `textContainerUpgrade` path (unchanged). For `{type:"session"}` → three containers built with `rebuildPageContainer` when the **layout shape** changes (screen enter/leave, `bottomBoxLines` changes, input↔sheet switch) and `textContainerUpgrade` for text-only updates within a container:
  1. transcript text container (top, `0..stripTopY`),
  2. bordered box container (bottom-anchored, `borderWidth:1, borderRadius:12, borderColor:15`, height = `bottomBoxLines*27 + inset`), content = `bottom.lines.join("\n")`,
  3. status corner container (top-right of the box), content = `bottom.status`,
  4. a full-canvas transparent `isEventCapture:1` overlay (the only capture container).
  Port container geometry/ID conventions from ClaudeHUD `input-strip.ts` (`INPUT_BOX_CONTAINER_ID`, `STATUS_CORNER_*`) and the `rebuildPageContainer` call shape from ClaudeHUD `chat.ts:buildPage` (~line 385-482, 460). Track the last layout signature (mode + line counts) to decide rebuild vs upgrade. Keep the 120ms debounce for the text-upgrade path; rebuilds are immediate but only on structural change.

- [ ] **Step 1: Update failing tests:** with a fake bridge, assert `render({type:"lines",...})` calls `textContainerUpgrade` (single container, unchanged); `render({type:"session",...})` first call issues a `rebuildPageContainer` with a transcript container + a bordered box container (`borderWidth:1`) + a status container + one `isEventCapture:1` overlay; a second session render with the **same** shape but changed text uses `textContainerUpgrade` (no rebuild); a mode switch input→sheet triggers a rebuild.
- [ ] **Step 2: Run** `npm test -- evenhub` → FAIL.
- [ ] **Step 3: Implement** the multi-container session path + the `render(model)` signature across all three files. Update the single call site `app.ts:297` `this.display.render(render(this.state))` (types already align once app compiles).
- [ ] **Step 4: Run** `npm test -- evenhub dom` → PASS.
- [ ] **Step 5: Commit** `glasses: display backends render the session bottom bar (multi-container)`.

---

### Task 4: `app.ts` — session focus/scroll state + transcript-focus gestures

**Files:**
- Modify: `glasses/src/app.ts`
- Modify: `glasses/src/app.test.ts`

**Interfaces — Consumes:** Task 2 (`SESSION_SCROLL_STEP`, `ScreenModel`).
**Produces:** extended session state:
```ts
interface SessionScreenState {
  hostKey: string; sessionId: string;
  offset: number;                 // transcript scroll (existing)
  focus: "transcript" | "bottom"; // NEW, default "transcript"
  draft: string;                  // NEW, dictation buffer, default ""
  mic: MicState;                  // NEW, default "idle"
  viewOffset: number;             // NEW, scroll within a tall box, default 0
  selected: number;               // NEW, highlighted sheet option, default 0
}
```

- Every place that sets `screen:"session"` initializes the new fields (`focus:"transcript", draft:"", mic:"idle", viewOffset:0, selected:0`). Add a factory `newSessionState(hostKey, sessionId)` and use it everywhere to avoid drift.
- Rewrite `onSession` transcript-focus gestures (the current `onSession` at `app.ts:487`):
  - `scrollUp`/`scrollDown` when `focus==="transcript"` → move `offset` by `SESSION_SCROLL_STEP` (was `SESSION_CONTENT_AREA`), clamped `[0, maxOffset]`; preserve the existing history-fetch-on-scroll-past-top and pending-overlay behavior.
  - `tap` when `focus==="transcript"` → if `offset>0` set `offset=0` (snap to newest); else set `focus:"bottom"`.
  - `doubleTap` when `focus==="transcript"` → back to home/session list (existing behavior).
  - When `focus==="bottom"`, delegate to bottom handlers (stubbed in this task to just no-op or return to transcript; Tasks 5–6 fill them in). Keep the code compiling and the transcript-focus tests green.

- [ ] **Step 1: Failing tests:** from a fresh session state, two `scrollUp`s move `offset` by exactly 2 each (not a page); `tap` while scrolled sets `offset=0`; `tap` at tail sets `focus:"bottom"`; `doubleTap` returns to home. Snap-to-tail and history-fetch-on-top still fire.
- [ ] **Step 2: Run** `npm test -- app` → FAIL.
- [ ] **Step 3: Implement** the state fields + factory + transcript-focus dispatch + 2-line scroll.
- [ ] **Step 4: Run** `npm test -- app` + `npm run typecheck` + `npm run build` → all PASS (the interface is now consistent end-to-end).
- [ ] **Step 5: Commit** `glasses: session focus state + 2-line transcript scroll`.

---

### Task 5: `app.ts` — bottom input mode (dictation-in-box, send/clear, actions menu)

**Files:**
- Modify: `glasses/src/app.ts`
- Modify: `glasses/src/app.test.ts`
- Modify: `glasses/src/render.ts` if the actions-rows builder needs the new context items (import cost only)

**Interfaces — Consumes:** Task 4 state; existing `HubAudioDictation` (`dictation.start(onResult)/stop()/cancel()`), `hub-client.sendInput`, existing confirm flow, `buildActionsRows`.
**Produces:** bottom-focus input-mode dispatch + a context-sensitive actions menu.

- When `focus==="bottom"` and there is **no** pending question (input mode):
  - `tap` → toggle dictation: if `mic==="idle"` start (`dictation.start`, set `mic:"recording"`); if `recording` stop (`dictation.stop`, set `mic:"finalising"`); ignore in `finalising`/`error`. On result, append to `draft` (`draft ? draft + " " + text : text`), reset `mic:"idle"`, `viewOffset:0`; on unavailable set `mic:"error"` then back to idle with a flash.
  - `scrollUp`/`scrollDown` → move `viewOffset` within a tall box by 1; at the top (scroll-up past max) or bottom (`viewOffset===0` scroll-down) hand focus back: `focus:"transcript"`. Empty draft → any scroll returns to transcript immediately.
  - `doubleTap` → open the actions menu.
- Extend `buildActionsRows` (render.ts) to be context-sensitive: when called with a draft present, prepend `{action:"send", text:"Send"}` and `{action:"clear", text:"Clear"}`. Keep existing rows. Add `"send"`/`"clear"` to the `ActionRow.action` union.
- Actions handling: `send` → `sendInput(host, id, draft)`, clear `draft`, flash `✓ queued`, mark pending, return to session. `clear` → `draft=""`. `restart/kill/delete` → existing paths (kill/delete via confirm). `back` → return to session (transcript focus). Remove the session→`reply` screen route (the `case "reply"` spawn path stays for `newPrompt`).

- [ ] **Step 1: Failing tests** (fake dictation + fake client): in bottom/input focus, `tap` starts dictation (`mic:"recording"`, `dictation.start` called); second `tap` stops (`dictation.stop`); a delivered result appends to `draft`; `doubleTap` opens actions with `Send`/`Clear` present; selecting `Send` calls `sendInput(host,id,draft)` and clears the draft + flashes; `Clear` empties the draft; empty-box scroll returns `focus:"transcript"`.
- [ ] **Step 2: Run** `npm test -- app` → FAIL.
- [ ] **Step 3: Implement** input-mode dispatch + context actions rows + send/clear + dictation wiring; delete the session→reply route.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Step 5: Commit** `glasses: dictate into the bottom box, send/clear via context actions`.

---

### Task 6: `app.ts` — question sheet mode; remove the question screen

**Files:**
- Modify: `glasses/src/app.ts` (remove the `question` screen + handler)
- Modify: `glasses/src/render.ts` (remove `renderQuestion`; question now renders via the session bottom)
- Modify: `glasses/src/app.test.ts`, `glasses/src/render.test.ts` (drop question-screen tests, add sheet tests)

**Interfaces — Consumes:** Task 2 sheet model, Task 5 dictation-in-box (for the "Dictate answer…" escape), `sendInput`.
**Produces:** question answering inline in the session bottom bar.

- When `focus==="bottom"` and a question **is** pending (sheet mode):
  - `scrollUp`/`scrollDown` → move `selected` through `[...options, "Dictate answer…"]`, clamped.
  - `tap` → if `selected` is an option index → `sendInput(host, id, String(selected+1))`, flash `✓ queued`, `focus:"transcript"`; if it's the trailing "Dictate answer…" row → switch to input mode dictation (start dictation; the resulting draft is sent as the answer via the same send path).
  - `doubleTap` → open the actions menu (which now also lists session actions while a question is pending).
- When a question appears while `focus==="bottom"` in input mode, drop `focus:"transcript"` on the next state derivation (so the new sheet isn't accidentally acted on) — mirror ClaudeHUD.
- Remove `screen:"question"`, the `question` state field, `onQuestion`, and `renderQuestion`. Redirect the old `case "answer"` action (in `buildActionsRows`/actions handling) so that selecting "Answer question" just focuses the bottom bar (the sheet is already there) — or drop the "answer" row entirely since the sheet is always visible when a question is pending. Prefer dropping the "answer" row.

- [ ] **Step 1: Failing tests:** a session with a pending question renders `bottom.mode==="sheet"`; in bottom focus, scroll moves `selected`; `tap` on option index 1 calls `sendInput(host,id,"2")` and flashes; `tap` on the "Dictate answer…" row starts dictation; a question arriving while in input focus resets `focus:"transcript"`. Remove obsolete question-screen tests.
- [ ] **Step 2: Run** `npm test -- app render` → FAIL.
- [ ] **Step 3: Implement** sheet-mode dispatch; delete the question screen + `renderQuestion` + related state/handlers/tests.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Step 5: Commit** `glasses: answer questions inline in the bottom sheet; remove question screen`.

---

### Task 7: integration verification + docs

**Files:**
- Modify: `glasses/README.md` (QA checklist + a short "session bottom bar" note)

- [ ] **Step 1:** Update `glasses/README.md`: replace the old "AskUserQuestion shows the option labels…" and reply-screen checklist items with the new flow — transcript scroll feels smooth (~2 lines); tap focuses the bottom bar; a pending question fills/grows/scrolls the bordered box and an option is tap-selectable; dictation into the box + Send works; no header line. Add a one-paragraph description of the two-mode bottom bar + focus model.
- [ ] **Step 2: Full verification:** in `glasses/` run `npm test` (all pass), `npm run typecheck` (clean), `npm run build` (clean). Then `npm run mock-hub` + `npm run dev` and drive the DOM backend: scroll a long transcript (2-line steps), tap into the bottom, confirm the mock-hub's pending-question session shows the sheet with options, scroll + select an option, and (input mode) exercise the PromptDictation → Send path. Note that real dictation + the drawn border are hardware-only.
- [ ] **Step 3: Commit** `glasses: README QA for the session bottom bar`.

---

## Self-Review Notes

- **Spec coverage:** bordered box (Task 3), two modes input/sheet (Tasks 2/5/6), question fills+grows+scroll+select (Task 6), header removed (Task 2), 2-line scroll (Tasks 2/4), status corner (Tasks 1/3), dictation-in-box (Task 5), actions menu context items (Task 5), question screen removed / reply screen kept (Task 6), hub/agent untouched (Global Constraints), verification (Task 7). All covered.
- **Type consistency:** `ScreenModel`/`BottomModel`/`MicState`/`SESSION_SCROLL_STEP`/`SessionScreenState` names are defined in Tasks 1–2 and reused verbatim in 3–6. `render(model)` signature changes in Task 3, matching the Task 2 return type.
- **Mid-plan build:** Task 2 intentionally leaves the tree non-compiling (render returns a new type before consumers update); Task 3 restores consistency; Task 4 is the first task that re-greens `npm run build`. Reviewers of Task 2 should gate on `npm test -- render` only.
