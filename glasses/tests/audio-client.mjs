#!/usr/bin/env node
// Standalone prover for the hub's `/audio` mic-dictation WebSocket path — no
// glasses hardware, no build step. Just Node's stdlib plus its built-in
// `WebSocket` global (Node >=22; see turma/server.js's `/audio` handler
// and `GET /api/ws-token` for the protocol this replays).
//
// Usage:
//   node tests/audio-client.mjs <hubUrl> <user:pass> <wav-or-pcm-file>
//
// Examples:
//   node tests/audio-client.mjs https://hub.example.com admin:secret ./sample.wav
//   node tests/audio-client.mjs http://localhost:8300 admin:secret ./sample.pcm
//
// Arguments:
//   <hubUrl>          The hub's base URL (http(s)://host[:port]). Mapped to
//                      ws(s):// for the /audio endpoint (same rule the
//                      glasses client's HubAudioDictation uses: https->wss,
//                      http->ws).
//   <user:pass>        HTTP Basic auth credentials for GET /api/ws-token
//                      (the same TURMA_USER:TURMA_PASSWORD the hub enforces).
//   <wav-or-pcm-file>  A 16kHz mono signed-16-bit-little-endian PCM file.
//                      A standard 44-byte RIFF/WAVE header is auto-detected
//                      (by "RIFF"/"WAVE" magic) and stripped; a bare .pcm
//                      file is streamed as-is.
//
// What it does: fetches a short-lived ws-token over HTTP Basic auth, opens
// `ws(s)://<hub>/audio?auth=<token>`, streams the PCM as 3200-byte binary
// frames every 100ms (3200 bytes = 100ms of 16kHz s16le mono audio — the
// same real-time pacing a live mic would produce), sends a
// `{"type":"finalize"}` text frame, prints the hub's `audio_result` JSON
// reply, then exits 0 (or exits 1 with `transcript.unavailable`). Exits
// non-zero on any connection/auth error, an early close with no result, or
// the 20s overall timeout.

import { readFile } from "node:fs/promises";

const FRAME_BYTES = 3200; // 100ms of 16kHz s16le mono PCM (16000 * 2 * 0.1)
const FRAME_INTERVAL_MS = 100;
const OVERALL_TIMEOUT_MS = 20_000;

function usage() {
  console.error("Usage: node tests/audio-client.mjs <hubUrl> <user:pass> <wav-or-pcm-file>");
  process.exit(2);
}

// RIFF/WAVE files start with the ASCII magic "RIFF" at byte 0 and "WAVE" at
// byte 8; turma/server.js's own `pcmToWav()` always writes exactly a
// 44-byte canonical header before the raw PCM data, so stripping a fixed 44
// bytes on that magic match is sufficient for this script's purposes. A file
// without the magic is assumed to already be bare PCM.
export function stripWavHeader(buf) {
  if (buf.length >= 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return buf.subarray(44);
  }
  return buf;
}

export function buildAudioWsUrl(hubUrl, token) {
  const wsBase = hubUrl
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://")
    .replace(/\/$/, "");
  return `${wsBase}/audio?auth=${encodeURIComponent(token)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWsToken(hubUrl, userPass) {
  const authHeader = "Basic " + Buffer.from(userPass, "utf8").toString("base64");
  const base = hubUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/ws-token`, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /api/ws-token failed: ${res.status} ${body}`);
  }
  const parsed = await res.json();
  if (!parsed.token) throw new Error("ws-token response had no `token` field");
  return parsed.token;
}

async function streamPcm(ws, pcm) {
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    const frame = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length));
    ws.send(frame);
    await sleep(FRAME_INTERVAL_MS);
  }
}

async function main() {
  const [hubUrl, userPass, filePath] = process.argv.slice(2);
  if (!hubUrl || !userPass || !filePath) usage();

  let raw;
  try {
    raw = await readFile(filePath);
  } catch (err) {
    console.error(`[audio-client] could not read ${filePath}: ${err.message}`);
    process.exit(1);
    return;
  }
  const pcm = stripWavHeader(raw);
  const seconds = (pcm.length / 32000).toFixed(2); // 32000 bytes/sec @16kHz s16le mono
  console.log(`[audio-client] loaded ${pcm.length} bytes of PCM (~${seconds}s @16kHz s16le mono) from ${filePath}`);

  let token;
  try {
    token = await fetchWsToken(hubUrl, userPass);
  } catch (err) {
    console.error(`[audio-client] ws-token fetch failed: ${err.message}`);
    process.exit(1);
    return;
  }

  const wsUrl = buildAudioWsUrl(hubUrl, token);
  console.log(`[audio-client] connecting to ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  let finished = false;
  const timeoutTimer = setTimeout(() => finish(1, `timed out after ${OVERALL_TIMEOUT_MS}ms waiting for audio_result`), OVERALL_TIMEOUT_MS);
  timeoutTimer.unref?.();

  function finish(code, message) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    if (message) {
      (code === 0 ? console.log : console.error)(`[audio-client] ${message}`);
    }
    try {
      ws.close();
    } catch {
      // ignore — already closed/never opened
    }
    process.exit(code);
  }

  ws.addEventListener("error", (ev) => {
    finish(1, `WebSocket error: ${ev.message ?? ev.error?.message ?? "unknown"}`);
  });

  ws.addEventListener("open", () => {
    console.log("[audio-client] connected — streaming PCM in real time...");
    void (async () => {
      try {
        await streamPcm(ws, pcm);
        console.log("[audio-client] finished streaming — sending finalize");
        ws.send(JSON.stringify({ type: "finalize" }));
      } catch (err) {
        finish(1, `streaming failed: ${err.message}`);
      }
    })();
  });

  ws.addEventListener("message", (ev) => {
    let parsed;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return; // not JSON text — ignore (no binary replies are expected)
    }
    if (parsed?.type !== "audio_result") return;
    console.log(JSON.stringify(parsed, null, 2));
    finish(parsed.transcript?.unavailable ? 1 : 0);
  });

  ws.addEventListener("close", () => {
    // A close before we ever saw audio_result — hub dropped us, auth
    // rejected the upgrade, etc. — is a failure from this script's view.
    finish(1, "connection closed before receiving an audio_result");
  });
}

// Only run when invoked directly (`node tests/audio-client.mjs ...`), not
// when imported for its pure helpers (stripWavHeader/buildAudioWsUrl) by a
// unit test.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
