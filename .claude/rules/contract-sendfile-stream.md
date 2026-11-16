---
paths:
  - agent/hub-agent.py
  - agent/tunnel-agent.js
  - agent/tests/test_hub_agent.py
  - agent/tests/tunnel-agent.test.js
  - turma/server.js
  - turma/tenant-scope.js
  - turma/tests/server.test.js
  - turma/public/chat.js
  - turma/tests/chat.test.js
  - android/app/src/main/java/com/xerktech/turma/ui/TranscriptView.kt
  - android/app/src/main/java/com/xerktech/turma/net/StreamedVideo.kt
---

# Streamed SendUserFile videos

A video a session sends that is too big to embed inline (`SEND_FILE_VIDEO_MAX_BYTES`, 4 MiB) is
streamed on demand instead, up to `SEND_FILE_STREAM_MAX_BYTES` (256 MiB). Spans agent, hub and
both clients.

- **The block carries a ref, never bytes**: `{name, kind:"video", stream:true, ref, size}`, `ref` =
  32 hex of sha256(path) (`send_file_ref` ↔ `sendFileRef`, one vector pinned on both sides; a lone
  surrogate hashes as U+FFFD).
- **The ref resolves ONLY to a path the session itself sent** (`_send_file_path_for_ref` re-reads
  its transcript's SendUserFile calls, video extensions only). Never join a ref onto a path.
- Flow: a client's `GET …/sessions/<id>/sendfile/<ref>?status=1` → `{state: pending|ready|error}`;
  the first one queues `fetchSendFile {sessionId, ref}`. The agent uploads on a worker (never the
  beat) to `POST /api/agents/<host>/sendfiles/<sid>/<ref>` (agent-authed, `X-Sendfile-Type`), or
  `?error=<why>` with no body. `GET` without `?status` serves the bytes with one Range.
- **The hub takes an upload only for a fetch it asked THAT host for** (a pending entry under the
  proved `<host>`), else 404 — an agent cannot push bytes into the spool.
- Served `nosniff` + `Content-Security-Policy: sandbox`, type from a video whitelist only.
- Spool: `SENDFILE_SPOOL_DIR` (`/data/sendfiles`), per pod; under HA the leader serves the POST
  and the GETs (XERK-919), a failover just refetches. Bounded by `SENDFILE_SPOOL_MAX_BYTES`
  (LRU), `SENDFILE_IDLE_MS`, `SENDFILE_ENTRIES_MAX`; boot deletes only `sf-*` names.
- Web: ▶ polls, then swaps in `<video src=…/sendfile/<ref>>`; only in the LIVE chat (an ended
  transcript has no running session to resolve against). `carryVideos` carries the box too.
- Android: polls via `HubApi.sendFileStatus`, downloads through the signed-in OkHttp client to the
  cache, plays the local file (`LocalSendFileSession` is provided by `ChatScreen` only).
- An older agent acks `fetchSendFile` and does nothing: the fetch errors after
  `SENDFILE_PENDING_MS` (10 min) with "the host did not send the file in time".
- Tests: `TestFetchSendFile`, `test_a_video_past_the_inline_cap_streams_by_ref`; the
  `sendFileRef` + streams cases in `tunnel-agent.test.js`; `sendfile:` in `server.test.js`; the
  streamed-video render case in `chat.test.js`; `ProseTest` (`videoSizeLabel`, decode).
