#!/bin/sh
# docker-entrypoint.sh — Start the OpenClaw gateway and control-api together.
#
# The gateway runs in the background as a WebSocket service that handles
# agent/chat sessions. The control-api connects to it on localhost.
set -e

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROFILE="${OPENCLAW_PROFILE:-dench}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
IDENTITY_DIR="${STATE_DIR}/identity"
DEVICE_FILE="${IDENTITY_DIR}/device.json"

# ── Generate device identity if missing ──────────────────────────────────────
# The gateway requires a device identity (Ed25519 keypair) for operator scopes.
# On localhost, the gateway auto-pairs unknown devices silently.
# deviceId must be sha256(raw-public-key). Regenerate if file uses old UUID format.
if [ -f "$DEVICE_FILE" ]; then
  OLD_ID="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${DEVICE_FILE}','utf8'));process.stdout.write(/^[0-9a-f]{64}$/.test(d.deviceId)?'ok':'bad')}catch{process.stdout.write('bad')}")"
  if [ "$OLD_ID" != "ok" ]; then
    echo "[entrypoint] Regenerating device identity (old format detected)..."
    rm -f "$DEVICE_FILE"
  fi
fi
if [ ! -f "$DEVICE_FILE" ]; then
  echo "[entrypoint] Generating device identity..."
  mkdir -p "$IDENTITY_DIR"
  node -e "
    const crypto = require('crypto');
    const fs = require('fs');
    const { generateKeyPairSync, createPublicKey, createHash } = crypto;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // deviceId must be SHA256(raw-public-key) — the gateway derives it the
    // same way and rejects mismatches.
    const spki = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    // SPKI DER for Ed25519 = 12-byte ASN.1 header + 32-byte raw key
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const rawKey = spki.subarray(prefix.length);
    const deviceId = createHash('sha256').update(rawKey).digest('hex');
    const identity = {
      deviceId,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    };
    fs.writeFileSync('${DEVICE_FILE}', JSON.stringify(identity, null, 2) + '\n');
    console.log('[entrypoint] Device identity created: ' + deviceId);
  "
fi

# ── Generate an internal shared token for gateway ↔ control-api auth ────────
# Token auth ensures sharedAuthOk=true so the gateway allows the connection
# even before the device is paired. The device identity + localhost then
# triggers silent auto-pairing, granting full operator scopes.
INTERNAL_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

export OPENCLAW_GATEWAY_TOKEN="$INTERNAL_TOKEN"

# ── Start gateway ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting OpenClaw gateway on port ${GATEWAY_PORT}..."

# Run the gateway in the background.
# --allow-unconfigured: skip the gateway.mode=local config requirement
# --auth token: shared-token auth so control-api can connect as operator
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
