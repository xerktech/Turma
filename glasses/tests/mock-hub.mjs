#!/usr/bin/env node
// Node stdlib mock of the hub API, for manual dev against `npm run dev`
// without a real hub/agent stack. Serves GET /api/agents from an in-memory
// fixture (2 hosts; one session with a pending question+options and a long
// tail, one with fresh PR links, one stopped, and one closed/resumable
// session), accepts the mutation endpoints and applies them to the fixture
// after a simulated delay (so the glasses client's pending overlay has
// something to show), serves GET .../history (202 once, then 200), and
// GET /api/ws-token. No auth is enforced — this is dev-only.
import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = parseInt(process.env.MOCK_HUB_PORT || "8301", 10);
const MUTATION_DELAY_MS = parseInt(process.env.MOCK_HUB_DELAY_MS || "3000", 10);

const now = () => Date.now();
const isoAgo = (sec) => new Date(now() - sec * 1000).toISOString();

function longTail() {
  const roles = ["user", "assistant"];
  const tail = [];
  for (let i = 0; i < 12; i++) {
    tail.push({
      id: `tail-${i}`,
      role: roles[i % 2],
      text:
        roles[i % 2] === "user"
          ? `Please look into issue #${i} and figure out the root cause.`
          : `I looked into issue #${i}. It looks like the root cause is a race condition in the connection pool; I'll patch the retry logic and add a regression test.`,
    });
  }
  return tail;
}

function makeFixture() {
  return {
    "host-1": {
      key: "host-1",
      device: "host-1",
      online: true,
      terminalOnline: true,
      startedAt: isoAgo(3600),
      repos: [
        { name: "myrepo", path: "/repos/myrepo" },
        { name: "other-repo", path: "/repos/other-repo" },
      ],
      sessions: [
        {
          id: "sess-aaa111",
          repo: "myrepo",
          branch: "agent/aaa111",
          label: "feature-x",
          status: "running",
          model: "claude-sonnet-5",
          permissionMode: "bypassPermissions",
          createdAt: isoAgo(1800),
          stoppedAt: null,
          errorMsg: null,
          usage: { today: { input: 12000, output: 3400, cacheWrite: 500, cacheRead: 9000, cost: 1.23 } },
          session: {
            bridgeAttached: true,
            transcriptAgeSec: 12,
            lastRole: "assistant",
            lastHasToolUse: true,
            question: "Which approach should I take?",
            questionOptions: ["Fast fix", "Proper refactor", "Ask more"],
            tail: longTail(),
            newPrUrls: [],
          },
        },
        {
          id: "sess-bbb222",
          repo: "other-repo",
          branch: "agent/bbb222",
          label: null,
          status: "running",
          model: "claude-sonnet-5",
          permissionMode: "default",
          createdAt: isoAgo(900),
          stoppedAt: null,
          errorMsg: null,
          usage: { today: { input: 4000, output: 900, cacheWrite: 0, cacheRead: 0, cost: 0.31 } },
          session: {
            bridgeAttached: true,
            transcriptAgeSec: 200,
            lastRole: "assistant",
            lastHasToolUse: false,
            question: null,
            questionOptions: [],
            tail: [
              { id: "t1", role: "user", text: "Ship the hotfix and open a PR." },
              { id: "t2", role: "assistant", text: "Pushed the hotfix and opened a PR for review." },
            ],
            newPrUrls: ["https://github.com/example/other-repo/pull/42"],
          },
        },
      ],
      closedSessions: [
        {
          id: "closed-ccc333",
          repo: "myrepo",
          branch: "agent/ccc333",
          label: "old-attempt",
          createdAt: isoAgo(7200),
          closedAt: isoAgo(3600),
        },
      ],
    },
    "host-2": {
      key: "host-2",
      device: "host-2",
      online: true,
      terminalOnline: false,
      startedAt: isoAgo(600),
      repos: [{ name: "another-repo", path: "/repos/another-repo" }],
      sessions: [
        {
          id: "sess-ddd444",
          repo: "another-repo",
          branch: "agent/ddd444",
          label: "stopped-one",
          status: "stopped",
          model: "claude-sonnet-5",
          permissionMode: "default",
          createdAt: isoAgo(5000),
          stoppedAt: isoAgo(100),
          errorMsg: null,
          usage: { today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } },
          session: null,
        },
      ],
      closedSessions: [],
    },
  };
}

const state = { agents: makeFixture() };
const historySeen = new Set(); // sessionIds that already got their first (202) history request

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function findSession(host, sessionId) {
  const agent = state.agents[host];
  return agent?.sessions.find((s) => s.id === sessionId);
}

// Applies a mutation after MUTATION_DELAY_MS, simulating the agent picking
// the queued command up on its next heartbeat.
function later(fn) {
  setTimeout(fn, MUTATION_DELAY_MS);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  // CORS so a `vite dev` origin (e.g. localhost:5173) can call this directly.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/ws-token") {
      return json(res, 200, { token: "mock-ws-token", expiresInSec: 300 });
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      const list = Object.values(state.agents);
      return json(res, 200, { now: now(), agents: list });
    }

    if (parts[0] === "api" && parts[1] === "agents" && parts[3] === "sessions") {
      const host = decodeURIComponent(parts[2]);
      const agent = state.agents[host];
      if (!agent) return json(res, 404, { error: "unknown agent" });

      if (req.method === "POST" && parts.length === 4) {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.repo) return json(res, 400, { error: "repo required" });
        const cmdId = randomBytes(6).toString("hex");
        later(() => {
          const id = `sess-${randomBytes(3).toString("hex")}`;
          agent.sessions.push({
            id,
            repo: body.repo,
            branch: `agent/${id.slice(5)}`,
            label: body.label || null,
            status: "running",
            model: body.model || "claude-sonnet-5",
            permissionMode: body.permissionMode || "default",
            createdAt: new Date().toISOString(),
            stoppedAt: null,
            errorMsg: null,
            usage: { today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } },
            session: {
              bridgeAttached: true,
              transcriptAgeSec: 0,
              lastRole: "user",
              lastHasToolUse: false,
              question: null,
              questionOptions: [],
              tail: body.prompt ? [{ id: "spawn-1", role: "user", text: body.prompt }] : [],
              newPrUrls: [],
            },
          });
        });
        return json(res, 200, { ok: true, cmdId });
      }

      const sessionId = decodeURIComponent(parts[4] || "");

      if (
        req.method === "POST" &&
        parts.length === 6 &&
        ["kill", "start", "restart", "resume"].includes(parts[5])
      ) {
        const action = parts[5];
        const cmdId = randomBytes(6).toString("hex");
        later(() => {
          if (action === "resume") {
            const idx = agent.closedSessions.findIndex((c) => c.id === sessionId);
            if (idx >= 0) {
              const closed = agent.closedSessions.splice(idx, 1)[0];
              agent.sessions.push({
                id: closed.id,
                repo: closed.repo,
                branch: closed.branch,
                label: closed.label,
                status: "running",
                model: "claude-sonnet-5",
                permissionMode: "default",
                createdAt: closed.createdAt,
                stoppedAt: null,
                errorMsg: null,
                usage: { today: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } },
                session: {
                  bridgeAttached: true,
                  transcriptAgeSec: 0,
                  lastRole: "assistant",
                  lastHasToolUse: false,
                  question: null,
                  questionOptions: [],
                  tail: [{ id: "resumed-1", role: "assistant", text: "Resumed from where we left off." }],
                  newPrUrls: [],
                },
              });
            }
            return;
          }
          const s = findSession(host, sessionId);
          if (!s) return;
          if (action === "kill") {
            s.status = "stopped";
            s.stoppedAt = new Date().toISOString();
            s.session = null;
          } else if (action === "start" || action === "restart") {
            s.status = "running";
            s.stoppedAt = null;
            s.session = {
              bridgeAttached: true,
              transcriptAgeSec: 0,
              lastRole: "assistant",
              lastHasToolUse: false,
              question: null,
              questionOptions: [],
              tail: [{ id: `${action}-1`, role: "assistant", text: `(${action}ed)` }],
              newPrUrls: [],
            };
          }
        });
        return json(res, 200, { ok: true, cmdId });
      }

      if (req.method === "POST" && parts.length === 6 && parts[5] === "input") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return json(res, 400, { error: "text required" });
        const cmdId = randomBytes(6).toString("hex");
        later(() => {
          const s = findSession(host, sessionId);
          if (!s || !s.session) return;
          s.session.tail.push({ id: `in-${randomBytes(3).toString("hex")}`, role: "user", text });
          s.session.question = null;
          s.session.questionOptions = [];
          s.session.transcriptAgeSec = 0;
        });
        return json(res, 200, { ok: true, cmdId });
      }

      if (req.method === "GET" && parts.length === 6 && parts[5] === "history") {
        if (!historySeen.has(sessionId)) {
          historySeen.add(sessionId);
          return json(res, 202, { pending: true, cmdId: randomBytes(6).toString("hex") });
        }
        return json(res, 200, {
          entries: [
            { id: "hist-1", role: "user", text: "(older) kicked off the original task here." },
            { id: "hist-2", role: "assistant", text: "(older) Got it, starting now." },
          ],
          truncated: false,
          fetchedAt: now(),
        });
      }

      if (req.method === "DELETE" && parts.length === 5) {
        const cmdId = randomBytes(6).toString("hex");
        later(() => {
          agent.sessions = agent.sessions.filter((s) => s.id !== sessionId);
        });
        return json(res, 200, { ok: true, cmdId });
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`mock-hub listening on :${PORT} (mutation delay ${MUTATION_DELAY_MS}ms)`);
});
