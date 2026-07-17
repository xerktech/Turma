# Changelog

Patch releases are auto-cut on every merge and listed on the [Releases page](../../releases).
This file rolls up each **minor** release — the changes since the previous minor. See
`RELEASING.md`.

<!-- releases:newest-first -->

## 0.4.0 — 2026-07-17

_No changes._

## 0.3.0 — 2026-07-16

First release of the unified pipeline: one `v<MAJOR>.<MINOR>.<PATCH>` tag carrying all five
components (turma image, agent image, glasses `.ehpk`, android `.apk`, native tarball) plus a
changelog, replacing the five per-component release streams whose versions had drifted out of
lockstep. Pre-`0.3.0` history lives under the legacy `glasses-v*` / `android-v*` /
`agent-native-v*` tags.
