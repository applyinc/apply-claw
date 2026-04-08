# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — AppLy Claw control-api
#
# Multi-stage build for Fly.io deployment.
# Build context: monorepo root (required for workspace packages).
#
# Usage:
#   docker build -t applyclaw-control-api .
#   docker run -p 4001:4001 -p 3101:3101 applyclaw-control-api
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies & build ────────────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# Install build tools for native modules (node-pty)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config first (cache layer)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/control-api/package.json apps/control-api/
COPY packages/shared-config/package.json packages/shared-config/
COPY packages/api-schema/package.json packages/api-schema/

# Install all workspace dependencies with the repo lockfile so build output
# stays identical between local, CI, and Fly images.
RUN pnpm install --frozen-lockfile --filter @applyclaw/control-api...

# Copy shared package sources and build them
COPY packages/shared-config/ packages/shared-config/
COPY packages/api-schema/ packages/api-schema/

RUN pnpm --filter @applyclaw/shared-config build && \
    pnpm --filter @applyclaw/api-schema build

# Copy root src/ files referenced by control-api (workspace-seed.ts)
COPY src/cli/workspace-seed.ts src/cli/

# Copy control-api source and build
COPY apps/control-api/ apps/control-api/

RUN pnpm --filter @applyclaw/control-api build
RUN test -f /app/apps/control-api/dist/index.mjs -o -f /app/apps/control-api/dist/index.js

# ── Stage 2: Production runner ───────────────────────────────────────────────
FROM node:22-slim AS runner

# node-pty runtime deps + util-linux provides `script` (used to allocate a PTY
# for the openclaw CLI so its output is line-buffered and flushed immediately)
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user
RUN groupadd --system appuser && useradd --system --gid appuser appuser

# Preserve monorepo structure so pnpm workspace links resolve correctly.
# tsdown leaves workspace packages (e.g. @applyclaw/shared-config) as
# external imports, so the full node_modules tree must be present.

# Root workspace files
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/node_modules/ ./node_modules/

# Shared packages (built dist only)
COPY --from=builder /app/packages/shared-config/package.json ./packages/shared-config/package.json
COPY --from=builder /app/packages/shared-config/node_modules/ ./packages/shared-config/node_modules/
COPY --from=builder /app/packages/shared-config/dist/ ./packages/shared-config/dist/
COPY --from=builder /app/packages/api-schema/package.json ./packages/api-schema/package.json
COPY --from=builder /app/packages/api-schema/node_modules/ ./packages/api-schema/node_modules/
COPY --from=builder /app/packages/api-schema/dist/ ./packages/api-schema/dist/

# control-api built artifacts
COPY --from=builder /app/apps/control-api/package.json ./apps/control-api/package.json
COPY --from=builder /app/apps/control-api/node_modules/ ./apps/control-api/node_modules/
COPY --from=builder /app/apps/control-api/dist/ ./apps/control-api/dist/

# Workspace-seed (referenced by workspace-service at runtime via relative import)
COPY --from=builder /app/src/cli/workspace-seed.ts ./src/cli/workspace-seed.ts

# Create state directory
RUN mkdir -p /data && chown appuser:appuser /data

ENV NODE_ENV=production
ENV CONTROL_API_HOST=0.0.0.0
ENV CONTROL_API_PORT=4001
ENV TERMINAL_WS_PORT=3101
ENV OPENCLAW_STATE_DIR=/data
ENV PATH=/app/node_modules/.bin:/app/apps/control-api/node_modules/.bin:$PATH

EXPOSE 4001
EXPOSE 3101

USER appuser

WORKDIR /app/apps/control-api

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "if [ -f dist/index.mjs ]; then exec node dist/index.mjs; else exec node dist/index.js; fi"]
