#!/usr/bin/env python3
# XERK-697 — host-proof drive of hub-agent.py's Windows terminal backend against
# the REAL pty-host. The manager analog of drive.mjs: it plays the MANAGER's
# control side (the pure-Python RFC 6455 control client + the pty helpers wired
# into _capture_pane/_type_into_pane/_tmux_alive/_kill_tmux) and proves they
# actually speak the pty-host's `inject`/`capture`/`alive`/`resize`/`kill`
# protocol. On Linux node-pty binds forkpty; on Windows the identical API binds
# ConPTY, so this exercises the wire the ConPTY path will use.
#
# Excluded from CI (not a `test_*.py`, needs node-pty installed): run it with
#   cd agent/win && npm ci && python3 pty-control-drive.py
# Exit 0 iff every check passes.

import importlib.util
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HUB = os.path.join(os.path.dirname(HERE), "hub-agent.py")

# Load hub-agent.py (hyphen in the name -> importlib) to drive its REAL helpers.
spec = importlib.util.spec_from_file_location("hub_agent_drive", HUB)
ha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ha)

STATE = os.path.join(HERE, "pty-control-drive.state.json")
LOG = os.path.join(HERE, "pty-control-drive.log")
SESSION = "driveC"
TOKEN = "drive-py-secret"
CHILD = os.environ.get("COMSPEC", "cmd.exe") if os.name == "nt" else "/bin/bash"

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def read_state(timeout=8.0):
    import json
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(STATE) as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = None
        if st and st.get("ctrlPort") and st.get("termPort"):
            return st
        time.sleep(0.05)
    return None


def rpc(port, op, token=TOKEN, **extra):
    msg = {"op": op}
    msg.update(extra)
    return ha._ws_control_rpc(port, token, msg)


def wait_capture(port, needle, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = rpc(port, "capture")
        if r and r.get("ok") and needle in (r.get("data") or ""):
            return True
        time.sleep(0.1)
    return False


def main():
    for f in (STATE, LOG):
        try:
            os.remove(f)
        except OSError:
            pass
    print(f"python {sys.version.split()[0]} · {sys.platform} · "
          f"node-pty backend = {'ConPTY' if os.name == 'nt' else 'forkpty'}")

    # --- SPAWN via a throwaway spawner that EXITS (the manager-restart property).
    node = os.environ.get("TURMA_NODE_EXE", "node")
    ptyhost = os.path.join(HERE, "pty-host.mjs")
    args = [node, ptyhost, "--session", SESSION, "--base-path", f"/term/{SESSION}",
            "--term-port", "0", "--ctrl-port", "0", "--state", STATE,
            "--auth-token", TOKEN, "--cwd", HERE, "--", CHILD]
    logf = open(LOG, "ab")
    # Detach exactly as _spawn_pty_host does, so the child outlives this driver.
    kw = {"start_new_session": True} if os.name != "nt" else {
        "creationflags": getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    subprocess.Popen(args, cwd=HERE, stdin=subprocess.DEVNULL,
                     stdout=logf, stderr=logf, close_fds=True, **kw)
    logf.close()
    st = read_state()
    check("pty-host published state with bound ports", bool(st),
          f"pid={st.get('pid')} term={st.get('termPort')} ctrl={st.get('ctrlPort')}"
          if st else "no state")
    if not st:
        return finish()
    ctrl = st["ctrlPort"]
    check("pty-host pid is alive", ha._pid_alive(int(st["pid"])))

    # --- ALIVE (has-session analog) over the pure-Python control client.
    r = rpc(ctrl, "alive")
    check("control `alive` returns ok+alive over the RFC6455 client",
          bool(r and r.get("ok") and r.get("alive")), str(r))

    # --- AUTH: a wrong control token must be refused (no 101 upgrade).
    bad = rpc(ctrl, "alive", token="wrong-token")
    check("control channel refuses a wrong token", bad is None)

    # --- INJECT + CAPTURE (send-keys / capture-pane analogs), raw submit.
    inj = rpc(ctrl, "inject", data="echo DRIVE_PY_RAW", submit=True)
    check("control `inject` accepted", bool(inj and inj.get("ok")))
    check("`capture` returns injected output", wait_capture(ctrl, "DRIVE_PY_RAW"))

    # --- BRACKETED PASTE via _pty_inject (the _type_into_pane Windows path),
    #     resolved through the state file exactly as the manager does.
    os.makedirs(ha.PTY_HOST_DIR, exist_ok=True)
    import shutil
    shutil.copyfile(STATE, ha._pty_state_path("agent-driveC"))
    pasted = ha._pty_inject("agent-driveC", "echo DRIVE_PY_PASTE")
    check("_pty_inject (bracketed paste) accepted", pasted)
    check("`capture` shows the pasted text", wait_capture(ctrl, "DRIVE_PY_PASTE"))
    check("_pty_capture reads via the state file", bool(
        ha._pty_capture("agent-driveC") and "DRIVE_PY_RAW" in ha._pty_capture("agent-driveC")))
    check("_pty_alive reads liveness via the state file",
          ha._pty_alive("agent-driveC"))

    # --- RESIZE.
    rz = rpc(ctrl, "resize", columns=100, rows=30)
    check("control `resize` accepted", bool(rz and rz.get("ok")))

    # --- KILL (kill-session analog) via _pty_teardown; the host must exit.
    ha._pty_teardown("agent-driveC")
    gone = False
    for _ in range(60):
        if not ha._pid_alive(int(st["pid"])):
            gone = True
            break
        time.sleep(0.05)
    check("host process exited after control kill", gone)
    check("_pty_teardown removed the state file",
          not os.path.exists(ha._pty_state_path("agent-driveC")))

    finish()


def finish():
    npass = sum(1 for r in results if r)
    print(f"\nRESULT: {npass}/{len(results)} checks passed")
    sys.exit(0 if npass == len(results) and results else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"DRIVER ERROR: {e}")
        sys.exit(2)
