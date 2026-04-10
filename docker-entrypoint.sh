#!/bin/sh
# docker-entrypoint.sh — Start the OpenClaw gateway and control-api together.
#
# The gateway runs in the background as a WebSocket service that handles
# agent/chat sessions. The control-api connects to it on localhost.
set -e

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROFILE="${OPENCLAW_PROFILE:-dench}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_DIR="${STATE_DIR}/config"
GATEWAY_CONFIG="${CONFIG_DIR}/openclaw.json"

# ── Write gateway config (disable device auth for localhost-only gateway) ────
if [ ! -f "$GATEWAY_CONFIG" ]; then
  echo "[entrypoint] Writing gateway config..."
  mkdir -p "$CONFIG_DIR"
  cat > "$GATEWAY_CONFIG" <<'CONFIGEOF'
{
  "gateway": {
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
CONFIGEOF
fi

export OPENCLAW_CONFIG_PATH="$GATEWAY_CONFIG"

# ── Start gateway ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting OpenClaw gateway on port ${GATEWAY_PORT}..."

# Run the gateway in the background.
# --allow-unconfigured: skip the gateway.mode=local config requirement
# --auth none: auth is handled by control-api, gateway is localhost only
# --bind loopback: listen only on 127.0.0.1
openclaw --profile "$PROFILE" gateway run \
  --port "$GATEWAY_PORT" \
  --allow-unconfigured \
  --auth none \
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
