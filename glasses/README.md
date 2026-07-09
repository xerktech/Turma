# @agenthub/glasses

Even Hub G2 smart-glasses client for AgentHub. `src/app.ts` is a
hardware-agnostic controller driven purely by the `GlassesDisplay` /
`Dictation` / `KeyValueStorage` interfaces; `src/main.ts` wires in either the
real Even Hub SDK backend (`src/display/evenhub.ts`, on-device) or a DOM dev
backend (`src/display/dom.ts`, `npm run dev`), chosen automatically by
racing `waitForEvenAppBridge()` against a short timeout.

## Before packing: edit the network whitelist

`app.json`'s `network` permission whitelists exactly the hosts this app is
allowed to reach (`https://agents.xerktech.com` / `wss://agents.xerktech.com`
— xerktech's own hub). **If you're self-hosting AgentHub's hub under your
own domain, edit `app.json`'s `permissions[].whitelist` to your hub's
hostname before running `npm run pack`** — Even Hub enforces this whitelist
at the WebView network layer, so a stale entry means the packaged app simply
can't reach your hub.

## Scripts

- `npm run dev` — Vite dev server, DOM backend, keyboard-driven (arrows =
  scroll, Enter = tap, Escape = double-tap).
- `npm run build` — typecheck + production build (`dist/`).
- `npm test` / `npm run typecheck` — vitest / `tsc --noEmit`.
- `npm run pack` — builds and packages `dist/` + `app.json` into an
  `.ehpk` via `@evenrealities/evenhub-cli` (one directory up, alongside this
  package).
- `npm run simulate` — launches `@evenrealities/evenhub-simulator` against
  the local dev server (run `npm run dev` first).
- `npm run mock-hub` — a stdlib Node mock of the hub API for manual dev
  without a real hub/agent stack.
