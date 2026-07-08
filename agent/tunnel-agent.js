#!/usr/bin/env node
// Reverse-tunnel client for the agent-hub terminal gateway (compose/claude-code.yaml).
//
// Runs in the background of every AgentHub container (started by
// entrypoint.sh) alongside hub-agent.py — ONE control channel per host, keyed
// by container name. It keeps a persistent OUTBOUND WebSocket to the hub's
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

// Same container name the hub keys agents by (docker inspect via the mounted
// socket), matching hub-agent.py so /term/<name> lines up.
function containerName() {
  try {
    const out = execFileSync("docker", ["inspect", "--format", "{{.Name}}", os.hostname()], {
      timeout: 15000,
    });
    const n = out.toString().trim().replace(/^\//, "");
    if (n) return n;
  } catch {
    /* fall through */
  }
  return process.env.APP_NAME || os.hostname();
}

const NAME = containerName();

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
