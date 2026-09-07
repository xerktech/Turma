# ttyd 1.7.7 web client — vendored, verbatim

`index.html` is the **exact, unmodified** browser client that `ttyd 1.7.7` serves
— the version `agent/native/install.sh` pins (`TTYD_VERSION="1.7.7"`). The pty-host
(`../../pty-host.mjs`) serves these bytes so the Windows agent's terminal renders
byte-identically to the Linux fleet's ttyd, and so `turma/server.js`'s `proxyTerm`
can inject its font/scroll/OSC52 shims into the same `</head>` and drive the same
`window.term` with no hub-side change.

It is a single self-contained document: xterm.js, the CSS, the `tty`-protocol
client and the favicon (a data: URI) are all inlined. There are **no separate
asset requests** — only `GET <base>/`, `GET <base>/token`, and the websocket at
`<base>/ws`.

## How to reproduce (and re-vendor for a new ttyd)

```sh
arch=$(uname -m)   # x86_64 | aarch64
curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${arch}" -o ttyd && chmod +x ttyd
./ttyd -p 39777 -i 127.0.0.1 -b /term/spike -W -m 8 bash &
curl -s "http://127.0.0.1:39777/term/spike/" > index.html   # the vendored file
kill %1
```

The client is base-path-agnostic (it builds its `/token` and `/ws` URLs from
`window.location.pathname`), so the capture base path does not matter.

`LICENSE` is ttyd's MIT license (`github.com/tsl0922/ttyd`, tag 1.7.7).

**When bumping the pinned ttyd:** re-capture, re-vendor both files, rename this
dir, and re-run `agent/win/test/tty-protocol.test.mjs` — its
"vendored ttyd client keeps every hub-integration anchor" case fails if a new
ttyd dropped `</head>`, `window.term`, the `tty` subprotocol, `/token`, `/ws`, or
the `window.location.pathname` URL construction the hub integration depends on.
