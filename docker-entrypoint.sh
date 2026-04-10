#!/bin/sh
# docker-entrypoint.sh — Start the OpenClaw gateway and control-api together.
#
# The gateway runs in the background as a WebSocket service that handles
# agent/chat sessions. The control-api connects to it on localhost.
set -e

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROFILE="${OPENCLAW_PROFILE:-dench}"

# ── Generate an internal shared token for gateway ↔ control-api auth ────────
# This token is only used inside the container (loopback). It allows the
# control-api to authenticate as an operator without device identity.
INTERNAL_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

export OPENCLAW_GATEWAY_TOKEN="$INTERNAL_TOKEN"

# ── Start gateway ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting OpenClaw gateway on port ${GATEWAY_PORT}..."

# Run the gateway in the background.
# --allow-unconfigured: skip the gateway.mode=local config requirement
# --auth token: shared-token auth so control-api can connect without device identity
# --bind loopback: listen only on 127.0.0.1
openclaw --profile "$PROFILE" gateway run \
  --port "$GATEWAY_PORT" \
  --allow-unconfigured \
  --auth token \
  --bind loopback &

GATEWAY_PID=$!

# Give the gateway a moment to start
sleep 2

echo "[entrypoint] Gateway started (PID ${GATEWAY_PID}). Starting control-api..."

# ── Start control-api ────────────────────────────────────────────────────────
if [ -f dist/index.mjs ]; then
  exec node dist/index.mjs
else
  exec node dist/index.js
fi
