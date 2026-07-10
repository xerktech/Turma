# Glasses Overlay Option Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the glasses actions menu and Kill/Delete confirm dialog as a bordered-box overlay on top of the still-visible session transcript instead of navigating to a full-screen page.

**Architecture:** Render-only change. `render()` currently maps `screen === "actions"` / `"confirm"` to a full-screen `{type:"lines"}` page; it will instead return the existing `{type:"session"}` layout (transcript container + bordered bottom box) with a new `menu`-mode bottom box drawn over the underlying session's transcript. A `menuBox` helper (mirroring `sheetBody`) builds the box body; a shared `boxLineCount` sizes both the transcript window (render) and the box container (evenhub backend). The `onActions`/`onConfirm` input dispatch and the `screen` state machine are untouched, except the now-removed `restart` action.

**Tech Stack:** Vite + TypeScript, Vitest. Package root: `glasses/`. All render code is pure (state in → model out).

## Global Constraints

- Render functions stay **pure**: `(state) → ScreenModel`, no I/O, no `Date.now`.
- Display geometry: `DISPLAY_LINES = 10` text lines on the G2's 576×288 canvas; `LINE_WIDTH_PX = 560`; `BOTTOM_MAX_LINES = 5` (from `input-box.ts`).
- The menu box caps at `MENU_MAX_LINES = DISPLAY_LINES - 2 = 8`, leaving ≥2 transcript lines visible.
- Selected-row marker string is `"> "` (selected) / `"  "` (unselected) — exactly as `markerLine`/`sheetBody` already use.
- The hub still supports a `restart` session action server-side; only the glasses **menu row** and its `runAction` case are removed. Do not touch `queueAction`'s type union or the hub client.
- Run all commands from `glasses/`. Verify with `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: `menuBox` helper + `MENU_MAX_LINES` (input-box.ts)

**Files:**
- Modify: `glasses/src/input-box.ts`
- Test: `glasses/src/input-box.test.ts`

**Interfaces:**
- Consumes: `DISPLAY_LINES`, `LINE_WIDTH_PX` from `./layout.ts` (already imported); `wrapText` from `./text-wrap.ts` (already imported).
- Produces:
  - `export const MENU_MAX_LINES: number` (= 8)
  - `export function menuBox(opts: { title: string; rows: string[]; selected: number }): string[]`

- [ ] **Step 1: Write the failing tests**

Append to `glasses/src/input-box.test.ts` (and add `MENU_MAX_LINES, menuBox` to the existing import on line 2):

```ts
describe("menuBox", () => {
  it("renders a title line followed by option rows, marking the selected one", () => {
    expect(menuBox({ title: "Options", rows: ["Back", "Kill", "Delete"], selected: 1 })).toEqual([
      "Options",
      "  Back",
      "> Kill",
      "  Delete",
    ]);
  });

  it("clamps an out-of-range selected index so a row is always marked", () => {
    const out = menuBox({ title: "Options", rows: ["Back", "Kill"], selected: 9 });
    expect(out).toEqual(["Options", "  Back", "> Kill"]);
  });

  it("caps total output at MENU_MAX_LINES, windowing rows around the selection", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `row${i}`);
    const out = menuBox({ title: "Options", rows, selected: 8 });
    expect(out.length).toBe(MENU_MAX_LINES);
    expect(out[0]).toBe("Options");
    expect(out).toContain("> row8"); // selection stays visible
  });

  it("MENU_MAX_LINES leaves at least two transcript lines", () => {
    expect(MENU_MAX_LINES).toBe(8);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd glasses && npx vitest run src/input-box.test.ts`
Expected: FAIL — `menuBox is not a function` / `MENU_MAX_LINES` undefined.

- [ ] **Step 3: Implement `MENU_MAX_LINES` and `menuBox`**

In `glasses/src/input-box.ts`, add after `BOTTOM_MAX_LINES` (after line 16):

```ts
// The menu-overlay box (actions menu / confirm dialog) is taller than the
// input/sheet box: it may show a title plus several option rows. Cap it so at
// least two transcript lines stay visible behind it.
export const MENU_MAX_LINES = DISPLAY_LINES - 2;
```

And add at the end of the file (after `statusLabel`):

```ts
// Menu-mode body for the actions/confirm overlay: a wrapped title line (or
// lines) followed by option rows, each prefixed "> " when selected / "  "
// otherwise, windowed around `selected` so it stays visible when the list
// overflows MENU_MAX_LINES. Mirrors sheetBody's windowing, minus the numbering.
export function menuBox(opts: { title: string; rows: string[]; selected: number }): string[] {
  const { title, rows } = opts;
  const total = rows.length;
  // Clamp `selected` once so the window math and the row marking agree even
  // if a caller passes an out-of-range index.
  const selected = Math.max(0, Math.min(opts.selected, total - 1));

  // Reserve at least one option row: cap the title portion, the option area is
  // whatever's left, keeping the combined output within MENU_MAX_LINES.
  const titleLines = wrapText(title, LINE_WIDTH_PX).slice(0, MENU_MAX_LINES - 1);
  const area = MENU_MAX_LINES - titleLines.length;

  let start = 0;
  if (total > area) {
    start = Math.max(0, selected - Math.floor(area / 2));
    start = Math.min(start, total - area);
  }
  const visibleRows = rows
    .slice(start, start + area)
    .map((row, i) => (start + i === selected ? `> ${row}` : `  ${row}`));

  return [...titleLines, ...visibleRows];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd glasses && npx vitest run src/input-box.test.ts`
Expected: PASS (all `menuBox` + existing tests).

- [ ] **Step 5: Commit**

```bash
git add glasses/src/input-box.ts glasses/src/input-box.test.ts
git commit -m "glasses: add menuBox helper for overlay option menus"
```

---

### Task 2: Overlay renderers + revised actions rows (render.ts, app.ts)

**Files:**
- Modify: `glasses/src/render.ts` (BottomModel, ActionRow, `buildActionsRows`, `renderActions`, `renderConfirm`, `render()` dispatch; add `boxLineCount`, `sessionOverlay`)
- Modify: `glasses/src/app.ts` (remove the `runAction` `"restart"` case)
- Test: `glasses/src/render.test.ts`, `glasses/src/app.test.ts`

**Interfaces:**
- Consumes: `menuBox`, `MENU_MAX_LINES` from Task 1; existing `bottomBoxLines`, `sheetBody`, `inputBoxBody`, `statusLabel` from `./input-box.ts`; `sessionContentLines`, `confirmHeader`, `buildActionsRows`, `DISPLAY_LINES` (all in `render.ts`).
- Produces:
  - `BottomModel` gains `| { mode: "menu"; lines: string[]; status: string }`
  - `export function boxLineCount(bottom: BottomModel): number`
  - `ActionRow.action` no longer includes `"restart"`
  - `renderActions`/`renderConfirm` return `ScreenModel` (session overlay) instead of `string[]`

- [ ] **Step 1: Update the render tests to the overlay shape (failing)**

In `glasses/src/render.test.ts`, replace the entire `describe("render: actions", ...)` block (lines 333–403) with:

```ts
describe("render: actions", () => {
  it("renders the running-session menu as an overlay: Back first (cursor 0), no Send/Clear/Answer/Restart when there's no draft", () => {
    const s = session({ id: "s1", session: signals({ question: "pick" }) });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: newSessionState("host-a", "s1"),
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const model = asSession(render(state));
    expect(model.bottom.mode).toBe("menu");
    const box = model.bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  Kill");
    expect(box).toContain("  Delete");
    expect(box.some((l) => l.includes("Restart"))).toBe(false);
    expect(box.some((l) => l.includes("Answer question"))).toBe(false);
    expect(box.some((l) => l.includes("Send"))).toBe(false);
    expect(box.some((l) => l.includes("Clear"))).toBe(false);
  });

  it("keeps the session transcript visible behind the menu", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: newSessionState("host-a", "s1"),
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
      transcripts: { s1: { entries: [{ id: "e1", role: "assistant", text: "behind the menu" }] } },
    });

    const model = asSession(render(state));
    expect(model.transcriptLines.some((l) => l.includes("behind the menu"))).toBe(true);
    expect(model.bottom.mode).toBe("menu");
  });

  it("prepends Send/Clear/Dictate more after Back once the session's bottom-box draft has text", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: { ...newSessionState("host-a", "s1"), draft: "deploy the fix" },
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  Send");
    expect(box).toContain("  Clear");
    expect(box).toContain("  Dictate more");
    expect(box).toContain("  Kill");
  });

  it("ignores another session's draft (Send/Clear only reflect the actions target's own session)", () => {
    const s = session({ id: "s1" });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      session: { ...newSessionState("host-a", "other-session"), draft: "unrelated draft" },
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box.some((l) => l.includes("Send"))).toBe(false);
    expect(box.some((l) => l.includes("Clear"))).toBe(false);
  });

  it("shows Back/Start/Delete (no Kill, no Restart) when the session is stopped", () => {
    const s = session({ id: "s1", status: "stopped", session: null });
    const agents = [agent({ sessions: [s] })];
    const state = base({
      screen: "actions",
      agents,
      actions: { hostKey: "host-a", sessionId: "s1", cursor: 0 },
    });

    const box = asSession(render(state)).bottom.lines;
    expect(box).toContain("> Back");
    expect(box).toContain("  Start");
    expect(box).toContain("  Delete");
    expect(box.some((l) => l.includes("Kill"))).toBe(false);
    expect(box.some((l) => l.includes("Restart"))).toBe(false);
  });
});
```

In the same file, replace the `describe("render: confirm", ...)` block (lines 456–end of that block) with:

```ts
describe("render: confirm", () => {
  it("renders the kill confirmation as a menu overlay with Cancel preselected", () => {
    const state = base({
      screen: "confirm",
      confirm: { action: { kind: "kill", hostKey: "host-a", sessionId: "sess-0001" }, cursor: 0 },
    });
    const model = asSession(render(state));
    expect(model.bottom.mode).toBe("menu");
    expect(model.bottom.lines[0]).toBe("Kill sess-0?");
    expect(model.bottom.lines).toContain("> Cancel");
    expect(model.bottom.lines).toContain("  Confirm");
  });

  it("shows the delete confirmation wording with Confirm selected", () => {
    const state = base({
      screen: "confirm",
      confirm: { action: { kind: "delete", hostKey: "host-a", sessionId: "sess-0001" }, cursor: 1 },
    });
    const model = asSession(render(state));
    expect(model.bottom.lines[0]).toContain("Also removes branch");
    expect(model.bottom.lines).toContain("  Cancel");
    expect(model.bottom.lines).toContain("> Confirm");
  });
});
```

> Note: the `transcripts` fixture shape (`{ s1: { entries: [{ id, role, text }] } }`) matches the existing `TranscriptBuffer` fixtures already used throughout `render.test.ts` (e.g. line 141). The assertion only needs the one entry's text to appear behind the menu.

- [ ] **Step 2: Run the render tests to verify they fail**

Run: `cd glasses && npx vitest run src/render.test.ts`
Expected: FAIL — `asSession` gets a `"lines"` model (renderActions/renderConfirm still return lines), and `Restart` assertions flip.

- [ ] **Step 3: Add the `menu` BottomModel variant**

In `glasses/src/render.ts`, replace the `BottomModel` definition (lines 28–30):

```ts
export type BottomModel =
  | { mode: "input"; lines: string[]; status: string; focused: boolean }
  | { mode: "sheet"; lines: string[]; status: string; focused: boolean; options: string[]; selected: number }
  | { mode: "menu"; lines: string[]; status: string };
```

- [ ] **Step 4: Import `menuBox` and add `boxLineCount`**

Update the `input-box.ts` import (line 5) to include `menuBox`:

```ts
import { bottomBoxLines, inputBoxBody, menuBox, sheetBody, statusLabel, type MicState } from "./input-box.ts";
```

Add `boxLineCount` right after `renderSessionBottom` / before `sessionTranscriptArea` (near line 259):

```ts
// The bottom box's on-screen height in text lines. Input/sheet boxes cap at
// BOTTOM_MAX_LINES via bottomBoxLines; the menu box is already capped at
// MENU_MAX_LINES by menuBox, so it sizes to its own content (up to 8 lines).
// Shared by the evenhub backend (which sizes the box container) and
// sessionOverlay (which sizes the transcript above it) so the two never drift.
export function boxLineCount(bottom: BottomModel): number {
  return bottom.mode === "menu" ? Math.max(1, bottom.lines.length) : bottomBoxLines(bottom.lines);
}
```

- [ ] **Step 5: Add `sessionOverlay` and rewrite `renderActions` / `renderConfirm`**

Replace `renderActions` (lines 350–367) with:

```ts
// Builds the session-screen overlay used by the actions/confirm menus: the
// underlying session's transcript, bottom-anchored to whatever room the menu
// box leaves, with `bottom` (a menu-mode box) drawn over it. The transcript is
// static while a menu is open (the reveal only ticks on the session screen).
function sessionOverlay(state: AppState, hostKey: string, sessionId: string, bottom: BottomModel): ScreenModel {
  const content = sessionContentLines(state, hostKey, sessionId);
  const area = Math.max(1, DISPLAY_LINES - boxLineCount(bottom));
  const start = Math.max(0, content.length - area);
  return { type: "session", transcriptLines: content.slice(start), bottom };
}

function renderActions(state: AppState): ScreenModel {
  const a = state.actions;
  if (!a) return linesModel([headerLine(state, "Actions")]);
  const rows = buildActionsRows(state, a.hostKey, a.sessionId);
  const bottom: BottomModel = {
    mode: "menu",
    lines: menuBox({ title: "Options", rows: rows.map((r) => r.text), selected: a.cursor }),
    status: "",
  };
  return sessionOverlay(state, a.hostKey, a.sessionId, bottom);
}
```

Replace `renderConfirm` (lines 403–411) with:

```ts
function renderConfirm(state: AppState): ScreenModel {
  const c = state.confirm;
  if (!c) return linesModel([headerLine(state, "Confirm")]);
  const bottom: BottomModel = {
    mode: "menu",
    lines: menuBox({ title: confirmHeader(state), rows: ["Cancel", "Confirm"], selected: c.cursor }),
    status: "",
  };
  return sessionOverlay(state, c.action.hostKey, c.action.sessionId, bottom);
}
```

- [ ] **Step 6: Update the `render()` dispatch to not re-wrap**

In `render()` (lines 505–510), the `actions`/`confirm` cases now return a `ScreenModel` directly:

```ts
    case "actions":
      return renderActions(state);
    case "reply":
      return linesModel(renderReply(state));
    case "confirm":
      return renderConfirm(state);
```

- [ ] **Step 7: Revise `ActionRow` and `buildActionsRows` (drop Restart, Back first)**

Replace the `ActionRow` interface (lines 307–310) — remove `"restart"`:

```ts
export interface ActionRow {
  action: "send" | "clear" | "dictate" | "start" | "kill" | "delete" | "back";
  text: string;
}
```

Replace `buildActionsRows` (lines 320–348) with:

```ts
// Context-sensitive rows. Back is always cursor 0 so the default selection is
// a safe no-op (a stray tap backs out rather than acting). Restart is
// intentionally not offered on the glasses. Send/Clear/Dictate more appear only
// when the session's bottom-box draft (dictated in-box) actually has text to
// act on — read from `state.session` (the same session's draft), since the
// transient ActionsScreenState carries no draft of its own. There's no "Answer
// question" row: the sheet is always visible in the session bottom whenever a
// question is pending, so a menu path would be redundant.
export function buildActionsRows(state: AppState, hostKey: string, sessionId: string): ActionRow[] {
  const s = findSessionLocal(state, hostKey, sessionId);
  if (!s || s.status === "stopped") {
    return [
      { action: "back", text: "Back" },
      { action: "start", text: "Start" },
      { action: "delete", text: "Delete" },
    ];
  }
  const draft =
    state.session && state.session.hostKey === hostKey && state.session.sessionId === sessionId
      ? state.session.draft
      : "";
  const rows: ActionRow[] = [{ action: "back", text: "Back" }];
  if (draft) {
    // Send acts on the dictated draft, Clear discards it, "Dictate more"
    // appends another dictation (the append a bare tap used to do in place —
    // now an explicit choice so a tap doesn't record over text).
    rows.push({ action: "send", text: "Send" });
    rows.push({ action: "clear", text: "Clear" });
    rows.push({ action: "dictate", text: "Dictate more" });
  }
  rows.push({ action: "kill", text: "Kill" });
  rows.push({ action: "delete", text: "Delete" });
  return rows;
}
```

- [ ] **Step 8: Remove the `runAction` `"restart"` case (app.ts)**

In `glasses/src/app.ts`, delete the `case "restart":` block (lines 1095–1097):

```ts
      case "restart":
        this.queueAction(hostKey, sessionId, "restart");
        return;
```

Leave `queueAction`'s signature (`"kill" | "start" | "restart" | "resume"`) unchanged — `restart` is still a valid hub action, just no longer reachable from the menu.

- [ ] **Step 9: Fix the app.test.ts navigation for the new row order**

New draft-present order is `[Back, Send, Clear, Dictate more, Kill, Delete]`; no-draft running order is `[Back, Kill, Delete]`; stopped is `[Back, Start, Delete]`.

Edit `glasses/src/app.test.ts`:

**(a)** Around line 383 (sheet "Dictate answer…" → Send path) — insert a scroll to reach Send:
```ts
    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back, draft present)
    display.emit({ type: "scrollDown" }); // 1 = Send
    display.emit({ type: "tap" }); // select Send
```

**(b)** Around line 560 (input-mode Send) — same insert:
```ts
    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back)
    display.emit({ type: "scrollDown" }); // 1 = Send
    display.emit({ type: "tap" }); // select Send
```

**(c)** Around lines 586–588 (input-mode Clear) — Clear is now index 2:
```ts
    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back)
    display.emit({ type: "scrollDown" }); // 1 = Send
    display.emit({ type: "scrollDown" }); // 2 = Clear
    display.emit({ type: "tap" }); // select Clear
```

**(d)** Lines 607–615 (Back preserves draft) — Back is now cursor 0, no scrolling:
```ts
    // Draft present: rows are [Back, Send, Clear, Dictate more, Kill, Delete].
    display.emit({ type: "doubleTap" }); // -> actions, cursor 0 = Back
    display.emit({ type: "tap" }); // select Back
```
(Delete the six `scrollDown` emits that walked to the old Back position.)

**(e)** Line 809 comment only — change `cursor 0 = Restart` to `cursor 0 = Back`. The `scrollDown` → Kill (index 1) and following lines stay: rows are `[Back, Kill, Delete]`.

**(f)** Lines 825–843 (the "pending overlay clears after 60s even with no convergence" test) — this test queued a `restart`, which no longer exists. Requeue a **kill** on the still-running session (kill never converges because the fake keeps returning `running`). Replace the two emit lines (836–837) with:
```ts
    display.emit({ type: "doubleTap" }); // -> actions (cursor 0 = Back, no draft)
    display.emit({ type: "scrollDown" }); // 1 = Kill
    display.emit({ type: "tap" }); // -> confirm
    display.emit({ type: "scrollDown" }); // cursor -> Confirm
    display.emit({ type: "tap" }); // queue kill (session stays running, never converges)
```
The rest of the test (assert `pending["s1"]` defined, then cleared after 61s) is unchanged.

- [ ] **Step 10: Run typecheck + the affected suites**

Run: `cd glasses && npm run typecheck && npx vitest run src/render.test.ts src/app.test.ts`
Expected: PASS. Typecheck must be clean (removing `"restart"` from `ActionRow` must not leave a dangling reference — the `runAction` switch takes `action: string`, so it still compiles).

- [ ] **Step 11: Commit**

```bash
git add glasses/src/render.ts glasses/src/app.ts glasses/src/render.test.ts glasses/src/app.test.ts
git commit -m "glasses: render actions/confirm menus as session overlays; drop Restart, Back first"
```

---

### Task 3: Size the evenhub box container by `boxLineCount` (+ backend parity tests)

**Files:**
- Modify: `glasses/src/display/evenhub.ts` (use `boxLineCount` where it used `bottomBoxLines`)
- Test: `glasses/src/display/evenhub.test.ts`, `glasses/src/display/dom.test.ts`

**Interfaces:**
- Consumes: `boxLineCount` from `../render.ts` (Task 2); `BottomModel` type (already imported).

**Why:** The evenhub backend sizes the bordered box container's height from `bottomBoxLines(model.bottom.lines)`, which caps at 5. A menu box can be up to 8 lines, so without this change a tall menu would be clipped to a 5-line container. The DOM backend just concatenates `bottom.lines`, so it already renders any height — only a parity test is added there.

- [ ] **Step 1: Write the failing evenhub test**

In `glasses/src/display/evenhub.test.ts`, extend the `sessionModel` helper (lines 73–90) to accept `"menu"` mode:

```ts
function sessionModel(opts: {
  transcriptLines?: string[];
  mode?: "input" | "sheet" | "menu";
  lines?: string[];
  status?: string;
}): ScreenModel {
  const mode = opts.mode ?? "input";
  const lines = opts.lines ?? ["> draft"];
  const status = opts.status ?? "Working";
  let bottom: Extract<ScreenModel, { type: "session" }>["bottom"];
  if (mode === "input") bottom = { mode: "input", lines, status, focused: true };
  else if (mode === "sheet") bottom = { mode: "sheet", lines, status, focused: true, options: ["yes", "no"], selected: 0 };
  else bottom = { mode: "menu", lines, status };
  return { type: "session", transcriptLines: opts.transcriptLines ?? ["hello"], bottom };
}
```

Add a test inside `describe("render — session model (multi-container bottom bar)", ...)`:

```ts
it("sizes a menu-mode box container by its full line count (past the 5-line input/sheet cap)", async () => {
  const { bridge, rebuildCalls } = fakeBridge();
  const display = new EvenHubDisplay(bridge);
  await display.start();

  const sevenLineMenu = ["Options", "  Back", "  Send", "  Clear", "  Dictate more", "  Kill", "  Delete"];
  display.render(sessionModel({ mode: "menu", lines: sevenLineMenu, status: "" }));
  const tallBox = rebuildCalls[0]!.textObject!.find((c) => c.borderWidth === 1)!;

  // A shorter menu rebuilds (line count changed → new shape) and must be shorter.
  display.render(sessionModel({ mode: "menu", lines: ["Confirm?", "  Cancel", "  Confirm"], status: "" }));
  const shortBox = rebuildCalls[1]!.textObject!.find((c) => c.borderWidth === 1)!;

  expect(tallBox.content).toContain("Delete"); // all seven lines present, not truncated
  expect(tallBox.height!).toBeGreaterThan(shortBox.height!); // 7-line box taller than 3-line box
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd glasses && npx vitest run src/display/evenhub.test.ts`
Expected: FAIL — the box is sized by `bottomBoxLines` (capped at 5), so a 7-line and a 3-line menu box do not differ as expected (7-line clamped to 5), and/or `menu` mode isn't handled by the height math yet. (It may also fail to typecheck the new `menu` branch until Step 3 wires `boxLineCount`.)

- [ ] **Step 3: Swap `bottomBoxLines` for `boxLineCount` in evenhub.ts**

In `glasses/src/display/evenhub.ts`:

Remove the `bottomBoxLines` import (line 16) and import `boxLineCount` from render.ts instead. The render.ts import on line 12 is type-only; add a separate value import:

```ts
import type { BottomModel, ScreenModel } from "../render.ts";
import { boxLineCount } from "../render.ts";
```
(Delete `import { bottomBoxLines } from "../input-box.ts";`.)

Replace line 122 (in `sessionSignature`):
```ts
  return `${bottom.mode}:${boxLineCount(bottom)}`;
```

Replace line 320 (in `renderSession`):
```ts
      const boxLines = boxLineCount(model.bottom);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd glasses && npx vitest run src/display/evenhub.test.ts`
Expected: PASS (new + existing evenhub tests — input/sheet still size via `boxLineCount`, which returns `bottomBoxLines` for those modes, so their behavior is unchanged).

- [ ] **Step 5: Add a DOM-backend parity test**

In `glasses/src/display/dom.test.ts`, add:

```ts
it("renders a menu-mode session model (transcript, divider, then the menu box lines)", async () => {
  const el = makeEl();
  const display = new DomDisplay(el);
  await display.start();

  const model: ScreenModel = {
    type: "session",
    transcriptLines: ["assistant said hi"],
    bottom: { mode: "menu", lines: ["Options", "> Back", "  Kill", "  Delete"], status: "" },
  };
  display.render(model);

  const text = el.textContent ?? "";
  expect(text).toContain("assistant said hi");
  expect(text).toContain("Options");
  expect(text).toContain("> Back");
  expect(text.endsWith("Delete")).toBe(true);
});
```

- [ ] **Step 6: Run the DOM test**

Run: `cd glasses && npx vitest run src/display/dom.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck + build**

Run: `cd glasses && npm run typecheck && npm test && npm run build`
Expected: all green; production build succeeds.

- [ ] **Step 8: Commit**

```bash
git add glasses/src/display/evenhub.ts glasses/src/display/evenhub.test.ts glasses/src/display/dom.test.ts
git commit -m "glasses: size the evenhub menu box by boxLineCount so tall overlays aren't clipped"
```

---

## Self-Review

**Spec coverage:**
- Bordered-box overlay over the session transcript for actions + confirm → Task 2 (`sessionOverlay`, `renderActions`/`renderConfirm` return `{type:"session"}`).
- New `menu` BottomModel variant → Task 2, Step 3.
- `menuBox` mirroring `sheetBody`, grows-to-fit, caps at `MENU_MAX_LINES`, windows around selection → Task 1.
- Dispatch (`onActions`/`onConfirm`) unchanged → confirmed; only `runAction` `"restart"` removed (Task 2, Step 8).
- Display backends: evenhub needed the box-height change (spec flagged "verify") → Task 3; DOM needed none (parity test only).
- Actions row change: drop Restart, Back to top → Task 2, Step 7 (+ tests Steps 1, 9).

**Placeholder scan:** No TBD/TODO. Every code step shows full code. One conditional note (Task 2 Step 1) about the `transcripts` fixture shape — resolved by matching the existing test-file buffer shape, not a placeholder in shipped code.

**Type consistency:** `BottomModel` `menu` variant `{ mode, lines, status }` (no `selected`) is used consistently in render.ts, evenhub.ts (`sessionModel` helper), and dom.test.ts. `boxLineCount(bottom: BottomModel): number` signature matches all call sites. `menuBox({ title, rows, selected })` signature matches its two callers in render.ts. `ActionRow.action` union (minus `restart`) matches `buildActionsRows` outputs and the `runAction` string switch.
