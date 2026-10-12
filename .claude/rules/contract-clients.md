---
paths:
  - "turma/server.js"
  - "turma/public/**"
  - "android/app/src/**"
  - "glasses/src/**"
  - "turma/tests/**"
---

# Hub ⇄ client contracts

Rules every client (web, Android, glasses) must keep with the hub and with each other.

- **Web UI ⇄ Android parity (XERK-30).** `turma/public/` is the source of truth; Android must match.
  **A PR changing user-facing behavior in `turma/public/` must carry the matching `android/` change in
  the same PR** — or add a line to `android/PARITY.md` and say so in the PR. "User-facing" = a
  control, screen, state, chip, interaction or layout a person sees or touches; pure server/agent
  plumbing is exempt. Page → screen map in `android.md`. `PARITY.md` is the living gap tracker.
- **A hub refusal must reach the operator, in the hub's own words** (XERK-264). The hub refuses with a
  status and a JSON `{error}` body (409 org mismatch / unsupported agent, 503 host offline, 404 stale
  attachment, 413 too long, 429 queue full); a client that reads the body and ignores `res.status`
  shows a refused kill/rename/spawn as one that worked.
  - Web: `post()`/`del()` resolve **null on a refusal, having already toasted**
    `TurmaNav.refusalText`, and callers roll back whatever they painted optimistically.
    `TurmaNav.toast` is the ONE failure surface — nothing announces success through it, so a toast
    always means a command did not run.
  - Android: `hubErrorMessage` reads `{error}` off an `HttpException` or a typed `Response`;
    `FleetViewModel.run`/`ChatViewModel.report` word the snackbar from it and drop the optimistic
    pending row. **`/history` refusals are `HistoryResult.Failed`, never `Pending`** — polling can't
    fix a refusal.
  - Glasses (XERK-270): `hub-client.ts`'s `refusal()` reads the body BEFORE it throws, so the
    `HttpError` carries the hub's words, and `app.ts`'s `failureFlash` puts them on the display. Both
    halves or neither. `FLASH_HUB_UNREACHABLE` is only for a failure with **no status** — a dead
    socket or fetch timeout. A one-line header clips a long refusal (`headerLine`); the session screen
    wraps it whole.
  - All three fall back to "the hub answered HTTP `<n>`", worded identically on purpose.
