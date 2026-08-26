#!/usr/bin/env python3
"""The hub-agent side of a dsh session: the control-socket CLIENT and the
projection tail (XERK-467, [dsh][C]).

A dsh session is a headless dsh process in its own tmux (XERK-466 [B]), driven
NOT by a Claude-style TUI pane but over a per-session UNIX control socket the
dsh driver plugin binds. This module is the hub-agent (Python) end of that seam:

- `DshControl` connects to `~/.turma/dsh/<sessionId>.sock`, sends the four
  operations the contract defines (`input`, `answer`, `state`, `kill`) and
  receives the plugin's unsolicited events (`state`, `interaction`). It is what
  `send_input`/`notify_session`/`answer_question` reach for a dsh session
  instead of `_type_into_pane`. The socket carries CONTROL + liveness only; the
  display stream never rides it (see `DshProjectionTail`).

- `DshProjectionTail` tails the driver plugin's native dsh event log on disk and
  runs it through `DshProjector` (agent/dsh_transcript.py, [S1]), appending the
  derived Claude-Code JSONL projection to the pinned `<claudeSessionId>.jsonl`
  incrementally — so every existing transcript surface (hub-agent tail,
  tunnel-agent, history, archive) reads a dsh session with no change.

Contract of record: docs/dsh-session-lifecycle.md (XERK-466). LDJSON on the wire
(one compact JSON object per '\\n'). The plugin BINDS (server); this CONNECTS
(client).

Stdlib only, like agent/dsh_transcript.py and the rest of agent/ — imported by
hub-agent.py's dsh launcher.

Two invariants this module must never break, both because the caller runs on the
heartbeat's critical path (XERK-395: nothing on the beat may stall past the hub's
OFFLINE_AFTER_MS):
  * every public send (`input`/`answer`/`state`/`kill`) is bounded by a SHORT ack
    timeout and NEVER raises — a wedged dsh process must cost one bounded wait,
    not the host's online status;
  * the reader and projection threads are daemons that swallow their own errors
    and (for the reader) reconnect with backoff while the control is open.
"""

import json
import os
import socket
import threading
import time

try:
    # Imported as a sibling module by hub-agent.py (same dir on sys.path).
    from dsh_transcript import DshProjector
except ImportError:  # pragma: no cover - only when run outside the agent dir
    DshProjector = None


# How long a single op waits for its ack before giving up. Short on purpose: a
# send happens on the beat (send_input / notify_session / answer_question run in
# handle_commands), so a wedged plugin must not hold the beat. A lost ack is
# logged and the op reported failed, never retried inline.
DSH_ACK_TIMEOUT_SEC = float(os.environ.get("DSH_ACK_TIMEOUT_SEC", "5"))
# The startup window the socket has to appear in: the plugin binds it a moment
# after the dsh process starts, so the first connect retries briefly.
DSH_CONNECT_TIMEOUT_SEC = float(os.environ.get("DSH_CONNECT_TIMEOUT_SEC", "20"))
# Backoff bounds for the reader's reconnect loop while the control is open.
DSH_RECONNECT_MIN_SEC = 0.5
DSH_RECONNECT_MAX_SEC = 5.0
# One control frame is bounded so a malformed/hostile plugin line cannot grow the
# reader's buffer without limit. A real input frame is capped by INPUT_MAX_CHARS
# (100k) hub-side; this is generous above that and applies to a SINGLE line.
DSH_LINE_MAX_BYTES = int(os.environ.get("DSH_LINE_MAX_BYTES", str(4 << 20)))
# How often the projection tail wakes to look for new native events, when it is
# not being poked. Cheap: it only reads bytes appended since its last offset.
DSH_PROJECTION_POLL_SEC = float(os.environ.get("DSH_PROJECTION_POLL_SEC", "0.5"))


def _noop_log(_msg):
    pass


class DshControl:
    """Persistent control-socket client for ONE dsh session.

    `on_interaction(payload)` is called (on the reader thread) for each
    `{evt:"interaction", ...}` the plugin raises — the hub writes it to the
    AskUserQuestion rendezvous file. `on_state(payload)` and
    `on_interaction_end(payload)` are called for `{evt:"state"}` / `{evt:
    "interaction_end"}`. `on_peer_send(payload)` / `on_peer_inbound(payload)`
    are called for `{evt:"peer_send"}` / `{evt:"peer_inbound"}` — cross-session
    peer messaging (XERK-476). All run on the READER THREAD.

    **A callback MUST NOT call input()/answer()/state()/kill()**: those block
    waiting for an ack that only the reader thread delivers, so calling one from
    a callback deadlocks until the ack timeout. Callbacks only touch local state
    (write a file, set a dict). In hub-agent the operator's answer arrives on the
    beat thread (`_dsh_answer`), never from a callback, so this holds by
    construction. Callbacks must also be cheap and must not raise; guarded anyway.
    """

    def __init__(self, sock_path, on_interaction=None, on_state=None,
                 on_interaction_end=None, on_peer_send=None, on_peer_inbound=None,
                 log=None):
        self.sock_path = sock_path
        self._on_interaction = on_interaction
        self._on_state = on_state
        self._on_interaction_end = on_interaction_end
        # Cross-session peer messaging (XERK-476): `peer_send` is the dsh session's
        # send_message tool asking to reach a roster name; `peer_inbound` is a
        # native Claude-peer SendMessage that arrived at the driver's forged inbox
        # socket. Both run on the READER THREAD like the others, so the hub only
        # STAGES them (delivery — a write to another session's socket — happens on
        # the beat), holding the "a callback must not send" invariant.
        self._on_peer_send = on_peer_send
        self._on_peer_inbound = on_peer_inbound
        self._log = log or _noop_log
        self._sock = None
        self._io_lock = threading.Lock()     # one op in flight at a time
        self._ack = None                      # last ack seen, consumed by _send
        self._ack_evt = threading.Event()
        self._reader = None
        self._closed = False
        self._connected_once = False

    # -- lifecycle --------------------------------------------------------
    def start(self):
        """Open the connection (retrying for the startup window) and spawn the
        reader thread. Returns True once connected, False if the socket never
        appeared — the caller treats that as a launch failure."""
        deadline = time.time() + DSH_CONNECT_TIMEOUT_SEC
        while time.time() < deadline and not self._closed:
            if self._try_connect():
                self._connected_once = True
                self._reader = threading.Thread(
                    target=self._reader_loop, name="dsh-ctl", daemon=True)
                self._reader.start()
                return True
            time.sleep(DSH_RECONNECT_MIN_SEC)
        return False

    def _try_connect(self):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(DSH_ACK_TIMEOUT_SEC)
            s.connect(self.sock_path)
        except OSError:
            return False
        with self._io_lock:
            old, self._sock = self._sock, s
        if old is not None:
            try:
                old.close()
            except OSError:
                pass
        return True

    def close(self):
        """Stop the reader and drop the connection. Idempotent. Does NOT send a
        kill — the caller decides whether a clean `kill` op precedes teardown."""
        self._closed = True
        with self._io_lock:
            s, self._sock = self._sock, None
        if s is not None:
            try:
                s.close()
            except OSError:
                pass

    # -- reader -----------------------------------------------------------
    def _reader_loop(self):
        """Read LDJSON frames forever (while open): acks wake `_send`, events go
        to the callbacks. Reconnects with backoff if the socket drops but the
        control is still open (the dsh process outlives a transient disconnect)."""
        buf = b""
        backoff = DSH_RECONNECT_MIN_SEC
        while not self._closed:
            s = self._sock
            if s is None:
                if not self._try_connect():
                    time.sleep(backoff)
                    backoff = min(DSH_RECONNECT_MAX_SEC, backoff * 2)
                    continue
                backoff = DSH_RECONNECT_MIN_SEC
                buf = b""
                s = self._sock
            try:
                s.settimeout(1.0)
                chunk = s.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                chunk = b""
            if not chunk:
                # Peer closed (or errored). Drop this socket; the loop top will
                # reconnect while we are still open, else exit.
                with self._io_lock:
                    if self._sock is s:
                        self._sock = None
                try:
                    s.close()
                except OSError:
                    pass
                continue
            buf += chunk
            if len(buf) > DSH_LINE_MAX_BYTES and b"\n" not in buf:
                # A single frame past the cap with no newline: a broken/hostile
                # stream. Drop the buffer rather than grow it without bound.
                self._log(f"dsh-ctl: dropping oversize frame ({len(buf)} bytes)")
                buf = b""
                continue
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    self._dispatch(line)

    def _dispatch(self, line):
        try:
            obj = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return
        if not isinstance(obj, dict):
            return
        evt = obj.get("evt")
        if evt == "interaction":
            self._safe_cb(self._on_interaction, obj)
            return
        if evt == "state":
            self._safe_cb(self._on_state, obj)
            return
        if evt == "interaction_end":
            self._safe_cb(self._on_interaction_end, obj)
            return
        if evt == "peer_send":
            self._safe_cb(self._on_peer_send, obj)
            return
        if evt == "peer_inbound":
            self._safe_cb(self._on_peer_inbound, obj)
            return
        if evt is not None:
            return  # an event kind we don't handle — ignore, never treat as ack
        # No `evt`: it is an ack for the in-flight op.
        self._ack = obj
        self._ack_evt.set()

    def _safe_cb(self, cb, payload):
        if cb is None:
            return
        try:
            cb(payload)
        except Exception as e:  # a callback must never kill the reader
            self._log(f"dsh-ctl callback error: {e}")

    # -- ops --------------------------------------------------------------
    def _send(self, obj):
        """Send one op and wait for its ack. Returns the ack dict, or None on any
        failure (no socket, write error, or ack timeout). NEVER raises — the beat
        calls this."""
        if self._closed:
            return None
        try:
            payload = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        except (TypeError, ValueError):
            return None
        with self._io_lock:
            s = self._sock
            if s is None:
                return None
            self._ack = None
            self._ack_evt.clear()
            try:
                s.sendall(payload)
            except OSError as e:
                self._log(f"dsh-ctl send failed: {e}")
                return None
        if not self._ack_evt.wait(DSH_ACK_TIMEOUT_SEC):
            self._log(f"dsh-ctl: no ack for {obj.get('op')} within "
                      f"{DSH_ACK_TIMEOUT_SEC}s")
            return None
        return self._ack

    def input(self, text, kind="user", client_id=None, plugin=None):
        """Deliver a user turn to the dsh agent (its `followup`). `kind` is the
        UserMessage.source.kind — "user" for the operator (send_input), "machine"
        or "peer" for a manager-composed message (notify_session). Returns True on
        an ok ack."""
        source = {"kind": kind}
        if client_id:
            source["clientId"] = str(client_id)
        if plugin:
            source["plugin"] = str(plugin)
        ack = self._send({"op": "input", "source": source, "text": text})
        return bool(ack and ack.get("ok"))

    def answer(self, request_id, option_index=None, option_indices=None,
               text=None):
        """Answer a pending dsh-interaction named by `request_id`. Indices are
        0-based positions into the interaction event's options[] (same convention
        as answer_question / the AskUserQuestion picker — the plugin maps them to
        dsh's own selection). Returns True on an ok ack."""
        msg = {"op": "answer", "requestId": request_id}
        if option_indices:
            msg["optionIndices"] = option_indices
        if option_index is not None and option_index >= 0:
            msg["optionIndex"] = option_index
        if text is not None:
            msg["text"] = text
        ack = self._send(msg)
        return bool(ack and ack.get("ok"))

    def state(self):
        """Liveness snapshot: {status, eventCount, pendingInteraction} or None."""
        ack = self._send({"op": "state"})
        if ack and ack.get("ok"):
            return ack
        return None

    def kill(self):
        """Ask the plugin to dispose the agent and exit. Returns True on an ok
        ack. The caller still _kill_tmux's as the backstop if the ack/exit does
        not come (contract)."""
        ack = self._send({"op": "kill"})
        return bool(ack and ack.get("ok"))


class DshProjectionTail:
    """Tail the driver plugin's native dsh event log and append the derived
    Claude-JSONL projection to the pinned transcript, incrementally.

    The plugin writes one raw dsh SessionEvent dict per line to `events_path`
    (under the worktree's `.dsh/`); this reads bytes appended since its last
    offset, feeds whole lines to a single stateful `DshProjector`, and appends
    the projected entries to `transcript_path` (the pinned `<claudeSessionId>.jsonl`).

    Runs on its own daemon thread — never the beat (XERK-395) — and never raises:
    a bad event projects to nothing (DshProjector.feed is tolerant) and any IO
    error is logged and retried on the next poll.
    """

    def __init__(self, events_path, transcript_path, session_id,
                 cwd=None, git_branch=None, log=None):
        self.events_path = events_path
        self.transcript_path = transcript_path
        self._log = log or _noop_log
        self._proj = (DshProjector(session_id, cwd=cwd, git_branch=git_branch)
                      if DshProjector else None)
        self._offset = 0
        self._partial = b""
        self._stop = threading.Event()
        self._thread = None
        self._wake = threading.Event()

    def start(self):
        if self._proj is None:
            self._log("dsh projection: DshProjector unavailable; not tailing")
            return
        self._thread = threading.Thread(
            target=self._run, name="dsh-proj", daemon=True)
        self._thread.start()

    def poke(self):
        """Optional nudge to project immediately (e.g. right after an input)."""
        self._wake.set()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _run(self):
        # Ensure the transcript file exists so the pinned path resolves the moment
        # the session is launched (an empty file reads as an empty conversation).
        try:
            os.makedirs(os.path.dirname(self.transcript_path), exist_ok=True)
            if not os.path.exists(self.transcript_path):
                open(self.transcript_path, "a", encoding="utf-8").close()
        except OSError as e:
            self._log(f"dsh projection: cannot create transcript: {e}")
        while not self._stop.is_set():
            try:
                self._pump()
            except Exception as e:  # never let the tail thread die
                self._log(f"dsh projection error: {e}")
            self._wake.wait(DSH_PROJECTION_POLL_SEC)
            self._wake.clear()

    def _pump(self):
        try:
            size = os.path.getsize(self.events_path)
        except OSError:
            return  # events file not written yet
        if size < self._offset:
            # The native log was rewritten/truncated under us — start over. The
            # projection is a pure function of the log, so re-projecting from 0
            # reproduces the same (deterministic-uuid) entries; but appending
            # them again would duplicate, so this only happens on an explicit
            # rewrite, which the launcher avoids. Reset defensively.
            self._offset = 0
            self._partial = b""
        try:
            with open(self.events_path, "rb") as fh:
                fh.seek(self._offset)
                data = fh.read()
        except OSError:
            return
        if not data:
            return
        self._offset += len(data)
        self._partial += data
        entries = []
        while b"\n" in self._partial:
            line, self._partial = self._partial.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            for entry in self._proj.feed(event):
                entries.append(entry)
        if entries:
            self._append(entries)

    def _append(self, entries):
        try:
            with open(self.transcript_path, "a", encoding="utf-8") as fh:
                for e in entries:
                    fh.write(json.dumps(e, ensure_ascii=False) + "\n")
        except OSError as e:
            self._log(f"dsh projection append failed: {e}")
