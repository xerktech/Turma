# Turma — Veiller miniapp

The Veiller bundled-miniapp build of the Turma glasses client: the same Even
Realities G2 experience as `glasses/` (session list, live transcript, question
answering, G2-mic dictation), running as a Mentra miniapp inside the Veiller
app instead of as an Even Hub plugin. Ported from `glasses/` in Veiller's
XERK-211: the lens core (state, reducers, paging, rendering model) is carried
over verbatim; the display, input, and dictation backends are reimplemented on
the Mentra miniapp APIs; and the phone companion (Sessions + ticket Board)
runs in the miniapp's WebView, talking to the background script over WebView
channels.

Self-contained TypeScript: it has its own ported core and imports nothing from
this repo's `glasses/`.

## Layout

- `src/background/` — the JSContext entry: lens UI, session state, hub client.
- `src/ui/` — the WebView phone companion (plain DOM, no framework).
- `build.ts` — Bun build script. Emits `dist/background/index.js` (an IIFE —
  the JSContext evaluates a classic script, so ESM is a syntax error there)
  and `dist/ui/` (bundled HTML + assets).
- `miniapp.json` — the miniapp manifest (`packageName`, `version`, entries,
  permissions). The committed `version` is a dev default; the release pipeline
  stamps the real unified version at build time, exactly like it stamps
  `glasses/app.json`.
- `vendor/` — the two Mentra SDK tarballs the build depends on (see below).
- `scripts/pack.mjs` — packs `dist/` into the flat distribution zip.

## Vendored SDK tarballs

`vendor/` holds prebuilt tgz packages produced with `bun pm pack` from the
Veiller monorepo, since neither is published to a public registry:

- `mentra-miniapp-0.3.0-dev.1.tgz` — the `@mentra/miniapp` SDK, packed with
  its `dist/` prebuilt, its `workspace:*` dependency rewritten to `*`, and the
  `prepare` script stripped (so installing the tarball never tries to rebuild).
- `mentra-cloud-protocol-0.1.0-dev.0.tgz` — the source-only
  `@mentra/cloud-protocol` package, wired in through package.json `overrides`
  so the miniapp SDK's `*` dependency resolves to this tarball.

To regenerate after an SDK change: in the Veiller monorepo run `bun pm pack`
in `cloud/packages/miniapp-sdk` (after building its `dist/`, rewriting the
`workspace:*` dep to `*`, and removing `prepare`) and in
`cloud/packages/cloud-protocol`; drop the new tarballs in `vendor/`, update
the two `file:` references in `package.json`, and re-run `bun install` so
`bun.lock` picks them up.

## Build / test / pack

Bun is the toolchain (install, test runner, bundler):

```sh
cd veiller
bun install
bun run typecheck   # tsc --noEmit
bun test            # the ported core + backend suites
bun run build       # -> dist/background/index.js + dist/ui/
bun run pack        # -> build/<packageName>-<version>.zip
```

The zip is FLAT: `miniapp.json` and `icon.png` sit at the archive root next to
`background/` and `ui/` — that is the shape the Veiller app expects for a
bundled miniapp. `pack.mjs` accepts `--version X.Y.Z` and `--out <path>`.

## Release flow

`release.yml`'s `build-veiller` job stamps the unified release version into
`miniapp.json`, builds, and packs to a `turma-veiller-v<version>.zip` GitHub
release asset (manifest kind `asset`). The zip then gets bundled into the
Veiller app's `mobile/assets/miniapps/` in the Veiller repo.
