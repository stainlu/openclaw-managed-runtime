# Egress-proxy sidecar image for `networking: limited` sessions.
#
# Zero runtime dependencies — just stdlib `node:http` + `node:net` +
# `node:dgram`. node:alpine is the smallest Node distribution that still
# ships the full stdlib. Final image is ~65 MB.
#
# Design doc: docs/designs/networking-limited.md

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/stainlu/openclaw-managed-agents"
LABEL org.opencontainers.image.description="Egress-filtering sidecar for networking: limited sessions"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy only the three files that run in production. .test.mjs files
# exist but don't ship in the image.
COPY proxy.mjs allowlist.mjs dns.mjs ./

USER node

# The proxy binds:
#   TCP 8118 — HTTP(S) proxy
#   TCP 8119 — /healthz
#   UDP 53   — DNS filter
# EXPOSE is metadata only; actual publishing happens via docker-run -p.
EXPOSE 8118/tcp 8119/tcp 53/udp

# Healthcheck hits /healthz via the standard HTTP endpoint.
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8119/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "/app/proxy.mjs"]
