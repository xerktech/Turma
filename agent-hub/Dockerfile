FROM node:24-alpine

# Dashboard + command hub for the Claude Code containers. stdlib-only Node —
# no npm install layer. Agents (agent image) heartbeat to :8300.

ENV NODE_ENV=production
WORKDIR /app
COPY server.js ./
COPY public ./public

LABEL org.opencontainers.image.source="https://github.com/xerktech/DockerOps" \
      org.opencontainers.image.description="agent-hub: dashboard for headless Claude Code containers"

EXPOSE 8300
# /healthz is the one unauthenticated route — /api/agents now 401s without
# the basic-auth login, which reads as unhealthy and gets autoheal looping.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8300/healthz || exit 1

ENTRYPOINT ["node", "/app/server.js"]
