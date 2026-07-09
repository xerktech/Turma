#!/usr/bin/env node
// Reverse-tunnel client for the agent-hub terminal gateway (compose/claude-code.yaml).
//
// Runs in the background of every AgentHub container (started by
// entrypoint.sh) alongside hub-agent.py — ONE control channel per host, keyed
// by the host name. It keeps a persistent OUTBOUND WebSocket to the hub's
// control endpoint. When a browser opens a session's terminal in the Agent Hub,
// the hub sends {"open":<ch>,"port":<ttydPort>} on that control channel; we then
// dial back a data WebSocket for <ch> and bridge it to THAT session's local ttyd
// (127.0.0.1:<port>). The host multiplexes N per-session ttyds (one per port,
// allocated from TTYD_PORT_BASE by the manager); data channels fan out to them
// by port while the single control channel stays per-host. Because every
// connection here is outbound to HUB_URL, the hub and this container can live on
// different hosts/networks — no inbound reachability required.
//
// Zero dependencies: Node's built-in global WebSocket does all client-side
// framing/masking; we only shovel bytes between it and a net.Socket.

const net = require("net");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const HUB_URL = process.env.HUB_URL || "http://agent-hub:8300";
// Same agent token hub-agent.py heartbeats with (the hub's HUB_AGENT_TOKEN).
// Sent as a query param because the browser-style WebSocket client can't set
// an Authorization header.
const TOKEN = process.env.HUB_TOKEN || "";
const TTYD_HOST = "127.0.0.1";
// Fallback ttyd port when the hub doesn't specify one in the open message
// (safety only — the multiplexed sessions always send their own port).
const DEFAULT_TTYD_PORT = 7681;

// ws(s):// base derived from HUB_URL's scheme.
const WS_BASE = HUB_URL.replace(/^http/, "ws").replace(/\/+$/, "");

function log(msg) {
  console.log(`[tunnel-agent] ${msg}`);
}

// The physical host name the hub keys agents by — mirrors hub-agent.py's
// device_name() EXACTLY (same order, same sources, same rejects) so the control
// channel registers under the same key the heartbeat uses and /term/<name> lines
// up. With one container per host the container name is no longer the identity
// (they're all just "agent"); the host name is, and it's auto-discovered with no
// env/compose config. Crucially we never report the kernel-assigned container id
// (os.hostname() inside a container) as the device — that was the
// "fe0e38df73b4" bug.
const HOSTNAME_PLACEHOLDERS = new Set([
  "",
  "localhost",
  "unknown-device",
  "docker-desktop",
]);
const CONTAINER_ID_RE = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;

function usableHostname(name) {
  const n = (name || "").trim();
  if (HOSTNAME_PLACEHOLDERS.has(n.toLowerCase())) return "";
  if (CONTAINER_ID_RE.test(n)) return "";
  return n;
}

// The Docker daemon's own hostname via the bind-mounted socket — the automated
// cross-OS source (bare Linux -> host hostname; Docker-in-WSL -> the Windows
// machine name). See hub-agent.py docker_host_name().
function dockerHostName() {
  try {
    return execFileSync("docker", ["info", "--format", "{{.Name}}"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function deviceName() {
  try {
    const n = usableHostname(fs.readFileSync("/host/etc/hostname", "utf8"));
    if (n) return n;
  } catch {
    /* fall through */
  }
  const dockerName = usableHostname(dockerHostName());
  if (dockerName) return dockerName;
  try {
    const n = usableHostname(os.hostname());
    if (n) return n;
  } catch {
    /* fall through */
  }
  for (const env of ["DEVICE_NAME", "COMPUTERNAME"]) {
    const v = (process.env[env] || "").trim();
    if (v) return v;
  }
  log(
    "device name unresolved: /host/etc/hostname absent, `docker info` gave no " +
      "usable name, and the OS hostname is a container id — falling back to " +
      "'unknown-device' (set DEVICE_NAME to override)",
  );
  return "unknown-device";
}

const NAME = deviceName();

// Bridge one data channel: hub data-WS <-> the target session's local ttyd TCP.
// `port` selects which per-session ttyd to dial (defaults to 7681 for safety).
function openDataChannel(ch, port) {
  const url = `${WS_BASE}/agent/data?ch=${encodeURIComponent(ch)}&token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock = net.connect(port || DEFAULT_TTYD_PORT, TTYD_HOST);
  let open = false;
  const outbox = []; // ttyd bytes produced before the WS finished connecting

  const closeBoth = () => {
    try { ws.close(); } catch {}
    try { sock.destroy(); } catch {}
  };

  ws.addEventListener("open", () => {
    open = true;
    for (const b of outbox.splice(0)) ws.send(b);
  });
  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? Buffer.from(ev.data) : Buffer.from(ev.data);
    sock.write(data);
  });
  ws.addEventListener("close", closeBoth);
  ws.addEventListener("error", closeBoth);

  sock.on("data", (buf) => {
    if (open) ws.send(buf);
    else outbox.push(Buffer.from(buf));
  });
  sock.on("close", closeBoth);
  sock.on("error", (e) => {
    log(`ttyd connection error on channel ${ch}: ${e.message}`);
    closeBoth();
  });
}

let backoff = 1000;
function connectControl() {
  const url = `${WS_BASE}/agent/control?name=${encodeURIComponent(NAME)}&token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    backoff = 1000;
    log(`control channel connected to ${WS_BASE} as ${NAME}`);
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    } catch {
      return;
    }
    if (msg && msg.open) {
      const port = Number(msg.port) || DEFAULT_TTYD_PORT;
      openDataChannel(String(msg.open), port);
    }
  });
  const reconnect = () => {
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(connectControl, wait);
  };
  ws.addEventListener("close", () => {
    log(`control channel closed; reconnecting in ${Math.round(backoff / 1000)}s`);
    reconnect();
  });
  ws.addEventListener("error", (e) => {
    // 'close' fires after 'error'; let it drive the reconnect to avoid double.
    log(`control channel error: ${e.message || "connection failed"}`);
  });
}

log(`starting; hub=${WS_BASE} name=${NAME}`);
connectControl();
