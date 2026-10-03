FROM node:24-alpine

# Dashboard + command hub for the Claude Code fleet. stdlib-only Node —
# no app-dependency install layer. Native agents heartbeat to :8300.

# Pull the patched Alpine packages ahead of the base tag's next rebuild — the
# image scan gates HIGH/CRITICAL, and openssl (libcrypto3/libssl3) lags the
# node:24-alpine tag between rebuilds (CVE-2026-14456, fixed 3.5.8-r0).
RUN apk --no-cache upgrade

# npm — REMOVED, not pinned. The hub is stdlib-only and never runs npm, but the
# image scan gates HIGH/CRITICAL on npm's bundled node_modules, and pinning a
# newer npm stops working whenever no npm release yet carries a patched
# transitive dep (brace-expansion/undici, 2026-09). Nothing to scan, nothing to chase.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
WORKDIR /app
COPY server.js archive.js tar.js push.js usage-ledger.js usage-ledger-store.js permission-ledger.js ha-config.js store.js leader.js blobstore.js archive-mirror.js pgclient.js index-store.js relay.js forward.js ./
COPY public ./public

LABEL org.opencontainers.image.source="https://github.com/xerktech/DockerOps" \
      org.opencontainers.image.description="turma: dashboard for headless Claude Code containers"

EXPOSE 8300
# /healthz is the one unauthenticated route — /api/agents now 401s without
# the basic-auth login, which reads as unhealthy and gets autoheal looping.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8300/healthz || exit 1

ENTRYPOINT ["node", "/app/server.js"]
