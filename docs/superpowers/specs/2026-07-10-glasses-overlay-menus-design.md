# Glasses UI: options menus as bordered-box overlays

## Context

On the glasses session screen, the **actions menu** (Back / Send / Clear /
Dictate more / Kill / Delete) and the **confirm dialog** (Kill/Delete →
Cancel / Confirm) currently render as full-screen pages (`{type:"lines"}`) that
replace the whole screen. The user wants them to **pop up on top of the current
session** — a bordered box over the still-visible transcript — instead of
navigating to a new page. This matches ClaudeHUD's sheet model and reuses the
bordered-box machinery we already have for the session's bottom bar (the input
box and the AskUserQuestion sheet).

Scope (confirmed): **only** the actions menu and the confirm dialog — the two
menus that pop over a session. The spawn flow (host/repo/prompt pickers) and
Settings stay as their own pages (they're a navigation flow from home, with no
session to overlay).

## Approach: render-only, reuse the session layout

The session screen already renders as a multi-container `{type:"session",
transcriptLines, bottom}` — a transcript container plus a bordered box (the
`bottom` model, currently `input` or `sheet`). The Even Hub backend draws that
box with a 1px border; the DOM dev backend stacks it under a divider. We add a
third bottom mode, **`menu`**, and make the actions/confirm screens render as a
session layout with the menu as the bottom box. The transcript stays visible
above; nothing navigates away.

**Dispatch is unchanged.** `onActions` / `onConfirm` (cursor move on scroll, run
on tap, back on double-tap) and the `screen: "actions"` / `"confirm"` states are
untouched — only their **rendering** becomes an overlay. When a menu is open its
state carries the underlying session (`actions.{hostKey,sessionId}`,
`confirm.action.{hostKey,sessionId}`), so the transcript is available.

## Components

### `BottomModel` gains a `menu` variant (`render.ts`)
```ts
export type BottomModel =
  | { mode: "input"; lines: string[]; status: string; focused: boolean }
  | { mode: "sheet"; lines: string[]; status: string; focused: boolean; options: string[]; selected: number }
  | { mode: "menu"; lines: string[]; status: string; selected: number };
```
The display backends already draw `bottom.lines` (+ the status corner)
generically, so they need no change for a new mode that also provides `lines` +
`status`. (Verify in implementation; adjust only if a backend switches on
`bottom.mode`.) `menu` supplies `status: ""` (a menu has no working/waiting
label).

### `menuBox` helper (`input-box.ts`, mirroring `sheetBody`)
```ts
export const MENU_MAX_LINES = DISPLAY_LINES - 2; // keep >=2 transcript lines visible
export function menuBox(opts: { title: string; rows: string[]; selected: number }): string[];
```
Returns the box body: the wrapped `title` line(s) followed by the option `rows`,
each prefixed `> ` when selected / `  ` otherwise. Grows to fit; capped at
`MENU_MAX_LINES`, windowing the row list around `selected` (same centered-window
math as `sheetBody`) so the highlighted row is always visible. Pure + unit
tested.

### Actions-menu row changes (`buildActionsRows`, `render.ts`)
Two content changes to the actions rows, applied while we're here:
- **Drop `Restart`** — remove the `restart` row entirely (the `runAction`
  `"restart"` case and its tests go too; the row is no longer reachable).
- **`Back` moves to the top** of every variant, so cursor 0 (the default
  selection) is the safe no-op:
  - stopped: `Back / Start / Delete`
  - running, no draft: `Back / Kill / Delete`
  - running, with draft: `Back / Send / Clear / Dictate more / Kill / Delete`

### Overlay renderers (`render.ts`)
A shared helper builds the session-overlay layout given the underlying session
and a bottom model:
```ts
function sessionOverlay(state, hostKey, sessionId, bottom: BottomModel): ScreenModel {
  const content = sessionContentLines(state, hostKey, sessionId);
  const area = Math.max(1, DISPLAY_LINES - bottom.lines.length); // box height varies
  const visible = content.slice(Math.max(0, content.length - area)); // bottom-anchored, newest
  return { type: "session", transcriptLines: visible, bottom };
}
```
- `renderActions` → `sessionOverlay(state, a.hostKey, a.sessionId, { mode:"menu",
  lines: menuBox({ title: "Options", rows: buildActionsRows(...).map(r=>r.text), selected: a.cursor }), status:"", selected:a.cursor })`.
- `renderConfirm` → same, with `title: confirmHeader(state)` and rows `["Cancel","Confirm"]`, `selected: c.cursor`.
- `render()`'s dispatch already routes `"actions"`/`"confirm"` to these
  functions — only their return type changes from `linesModel(...)` to the
  `{type:"session"}` overlay.

The transcript window here is computed from the **menu box height directly**
(`bottom.lines.length`, up to `MENU_MAX_LINES`), not the input box's
`bottomBoxLines` cap of 5 — the menu can be taller. `sessionTranscriptArea` and
the plain `renderSession` are unchanged (they still use the input/sheet box,
which is ≤ 5 lines, and drive app.ts's transcript scroll math which the menus
don't touch).

### No change
- `app.ts` dispatch (`onActions`, `onConfirm`) and the `screen` state machine
  (aside from removing the now-dead `runAction` `"restart"` case).
- Display backends (they render `{type:"session"}` already), pending a
  one-line check that they don't switch on `bottom.mode`.
- Spawn flow, Settings, reply, question sheet.

## Behavior notes
- The transcript behind an open menu is **static** (the reveal only ticks while
  `screen === "session"`), which reads cleanly — no motion behind the menu.
- The default cursor (0) sits on the first row — now `Back` for the actions
  menu (a safe no-op), `Cancel` for the confirm dialog.
- The `✓ queued` flash still surfaces on the plain session screen after an
  action runs and the menu closes (unchanged).

## Files
- `glasses/src/input-box.ts` — `MENU_MAX_LINES`, `menuBox` (+ tests).
- `glasses/src/render.ts` — `menu` BottomModel variant, `sessionOverlay`,
  `renderActions`/`renderConfirm` return the overlay, `buildActionsRows` drops
  `Restart` and puts `Back` first (+ render tests updated).
- `glasses/src/app.ts` — remove the `runAction` `"restart"` case (+ tests).
- Display backends — verify `{type:"session"}` renders the menu box; adjust only
  if they mode-switch. DOM backend test if it asserts screen shape.

## Verification
- `npm test` + `npm run typecheck` + `npm run build` in `glasses/`.
- `npm run dev` + `mock-hub`: open a session, dictate a draft, tap → the actions
  menu appears as a bordered box over the transcript (not a new page); scroll
  moves the highlight; Kill → the confirm box overlays; Back/Cancel returns to
  the session with the box gone.
- Render-model tests: `renderActions`/`renderConfirm` return `{type:"session"}`
  with `bottom.mode === "menu"`, the transcript present above, the selected row
  marked, and the box windowed when the row list is long.
