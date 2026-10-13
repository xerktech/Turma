---
paths:
  - "turma/tests/server.test.js"
---

# `server.test.js` — pitfalls of its shared in-process hub

- **A test standing in for an agent's CONTROL channel uses `collectControlFrames`, never
  `collectFrames`** (rollup XERK-1584 #12.1, #17). The hub sends a keepalive `{ping}` text frame
  every `CONTROL_PING_EVERY_MS` (50ms here) and drops a channel silent for `CONTROL_DEAD_AFTER_MS`
  (400ms here). A bare collector neither pongs nor filters, so under load:
  - a ping lands at the text-frame index the test reads (`nextTextJson(frames, 0)` got `{ping}`);
  - the hub reaps the channel before it reads the frames under test, and a test asserting only
    "the hub stayed up" passes without reaching the code it names.
- Only a test OF liveness keeps `collectFrames` (the never-pongs drop, the mocked-timer keep).
- **A test whose point is that the hub PARSED a frame proves it with a later well-formed frame
  arriving**, not with a fixed sleep; the poison-frame test retries on a fresh channel if dropped.
