// XERK-1588: a Linux ttyd listens on an owner-only UNIX socket keyed by its
// session's port, and the tunnel must dial THAT, falling back to loopback TCP only
// where there is no socket (a Windows pty-host, or an older agent's ttyd). Its own
// file because the socket dir is fixed at require time off HOME, which must point
// at a scratch dir before the module loads.
const os = require("os");
const fs = require("fs");
const net = require("net");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ttyd-sock-"));
process.env.HOME = HOME;
process.env.DEVICE_NAME = "testhost";
process.env.TURMA_TOKEN = "x";
const { ttydSockPath, ttydTarget } = require("../tunnel-agent.js");

test("ttydSockPath names the file hub-agent.py's _ttyd_sock_path does", () => {
  assert.equal(ttydSockPath(7705), path.join(HOME, ".turma", "ttyd", "7705.sock"));
  assert.equal(ttydSockPath("7705"), path.join(HOME, ".turma", "ttyd", "7705.sock"));
  // Never a path built from junk: the port arrives hub-supplied.
  for (const bad of [0, -1, 1.5, "../x", "7705/../../etc", NaN, null, undefined]) {
    assert.equal(ttydSockPath(bad), null, String(bad));
  }
});

test("ttydTarget dials the socket when one is there, else loopback TCP", async () => {
  assert.deepEqual(ttydTarget(7706), { port: 7706, host: "127.0.0.1" });
  const sp = ttydSockPath(7706);
  fs.mkdirSync(path.dirname(sp), { recursive: true, mode: 0o700 });
  // A regular file there is not a socket: still TCP.
  fs.writeFileSync(sp, "x");
  assert.deepEqual(ttydTarget(7706), { port: 7706, host: "127.0.0.1" });
  fs.unlinkSync(sp);
  const srv = net.createServer((c) => c.end("ttyd"));
  await new Promise((r) => srv.listen(sp, r));
  try {
    assert.deepEqual(ttydTarget(7706), { path: sp });
    const got = await new Promise((resolve, reject) => {
      const s = net.connect(ttydTarget(7706));
      let buf = "";
      s.on("data", (d) => { buf += d; });
      s.on("end", () => resolve(buf));
      s.on("error", reject);
    });
    assert.equal(got, "ttyd");
  } finally {
    srv.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});
