import type { Agent } from "../src/types.js";

// A representative /api/agents payload: one online host, one waiting session,
// one working session, one stopped session, plus a second host with repos.
export function agentsFixture(): Agent[] {
  return [
    {
      key: "nas-agent",
      device: "nas-truenas",
      online: true,
      repos: [{ name: "AgentHub" }, { name: "DockerOps" }],
      sessions: [
        {
          id: "ef56",
          repo: "AgentHub",
          branch: "agent/ef56",
          status: "running",
          session: { transcriptAgeSec: 5, lastRole: "assistant", question: null, tail: [
            { role: "user", text: "add a health endpoint" },
            { role: "assistant", text: "Done. Added /healthz. [Edit]" },
          ] },
        },
        {
          id: "ab12",
          repo: "DockerOps",
          branch: "agent/ab12",
          status: "running",
          session: {
            transcriptAgeSec: 2,
            lastRole: "assistant",
            question: "Deploy to prod or staging first?",
            tail: [{ role: "assistant", text: "Ready to deploy." }],
          },
        },
        {
          id: "cd34",
          repo: "AgentHub",
          branch: "agent/cd34",
          status: "stopped",
          session: null,
        },
      ],
    },
    {
      key: "pi-agent",
      device: "pi",
      online: true,
      repos: [{ name: "SwitchBoard" }],
      sessions: [],
    },
  ];
}
