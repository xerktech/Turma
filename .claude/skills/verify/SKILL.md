---
name: verify
description: Exercise a Turma change end-to-end — boot the hub, feed it a real agent payload, drive the UI in a browser. Use when verifying changes to turma/, agent/, glasses/ or android/.
---

# Verifying Turma changes

Pick the surface the change reaches. **The hub UI is pixels — drive it in a
browser, not with curl.** Recipes below are the ones that actually work in the
agent container; each notes the trap that ate the time.

## Test suites (fast, but not verification on their own)

```bash
cd turma   && node --test tests/*.test.js          # ~60s, 189 tests
cd agent   && python3 -m unittest tests.test_hub_agent   # ~1s, 293 tests. NO pytest installed.
cd glasses && npm ci --cache /tmp/claude-1000/npm-cache && npm run typecheck && npx vitest run
cd android && gradle testDebugUnitTest --offline   # JVM unit tests
cd android && ANDROID_USER_HOME=/tmp/claude-1000/andhome gradle assembleDebug --offline
```

- **npm needs a cache override** — `/root/.npm` is root-owned and every npm
  command dies with EACCES: `--cache /tmp/claude-1000/npm-cache`.
- **`assembleDebug` needs `ANDROID_USER_HOME`** somewhere writable, else
  `validateSigningDebug` fails creating a debug keystore in `/root/.android`.
- The SDK here has build-tools **35.0.0 only**; `app/build.gradle.kts` pins it.

## Driving the hub UI (the real surface)

1. **Generate a payload from the real agent pipeline**, not by hand — import
   `agent/hub-agent.py` with `importlib`, point `ha.PROJECTS_ROOT` at a temp
   dir, write synthetic transcript JSONL, then call `ha.repo_usage_report()` /
   `ha.usage_report()`. This exercises the parser AND gives the hub a truthful
   body. Use >8 repos and several models to hit the interesting cases.

2. **Boot the hub** with `PORT`, `TURMA_USER/PASSWORD`, `TURMA_AGENT_TOKEN`,
   `STATE_FILE`, `ARCHIVE_DIR`, `ARCHIVE_DB` all pointed at temp paths.
   POST the payload to `/api/heartbeat` with `Authorization: Bearer <token>`.

3. **Browser: Chromium cannot launch in this container** (system deps missing,
   no sudo — chasing them via apt is a dead end; it exits silently even once
   ldd is satisfied). Run Chrome in Docker and drive it over CDP:

   ```bash
   # --network container:<self> so the hub on 127.0.0.1 and CDP share a namespace.
   # --network host is the PHYSICAL host's namespace, NOT this container's.
   CID=$(cat /proc/self/cgroup | grep -oE '[0-9a-f]{64}' | head -1)   # or `hostname`
   docker run -d --name verify-chrome --network container:$CID \
     --entrypoint chromium-browser zenika/alpine-chrome:latest \
     --headless --no-sandbox --disable-gpu --remote-debugging-port=9333 about:blank
   ```
   Then `chromium.connectOverCDP("http://127.0.0.1:9333")` with playwright-core
   (`npm install playwright-core --prefix /tmp/... --cache /tmp/...`).
   Clean up with `docker rm -f verify-chrome`.

### Two traps that will cost you an hour each

- **`httpCredentials` does nothing.** The hub 302s HTML navigations to `/login`
  and deliberately sends no `WWW-Authenticate`, so Basic is never challenged.
  Fill the login form instead:
  ```js
  await page.goto(base + "/login");
  await page.fill("#username, input[name=username]", "u");
  await page.fill("#password, input[name=password]", "p");
  await Promise.all([page.waitForNavigation({waitUntil:"load"}).catch(()=>{}), page.click("button")]);
  ```
- **Never `waitUntil: "networkidle"`.** Every page holds an SSE stream
  (`/api/events`), so it never goes idle and you get a TimeoutError. Use
  `"load"` + a short `waitForTimeout`.

### Ports and orphans

`ps`/`pkill` do **not** exist here. A crashed driver script leaves a hub
holding its port, and the next run silently talks to the ORPHAN (symptom: an
inexplicable 401, because the orphan has a different token). Always install
`process.on("exit", () => srv.kill("SIGKILL"))` in the driver, and pick an
unusual port — other agent sessions run their own hubs on 8300/8399.
To find strays: scan `/proc/*/cmdline`, but match tightly — a loose pattern
kills other sessions' servers and your own shell.

## Worth probing on a UI change

Read computed style, not just the DOM — `el.style.background` (the shorthand)
resets `background-image`, which is exactly how a texture bug hid behind a
correct-looking chart. Also: toggle a legend series (survivors must not
repaint), toggle all off (empty state, no crash), feed a payload from an
"older agent" missing newer fields (must degrade, not throw), and check light
+ dark + a 390px viewport.
