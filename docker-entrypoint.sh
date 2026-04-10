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
DEVICES_DIR="${STATE_DIR}/devices"
PAIRED_FILE="${DEVICES_DIR}/paired.json"

# ── Generate device identity + pre-pair if missing ───────────────────────────
# The gateway requires a device identity (Ed25519 keypair) AND that the device
# is paired (registered in devices/paired.json) to grant operator scopes.
# Locally the CLI bootstrap does this interactively; in Docker we do it
# at container start by writing both files before the gateway starts.
#
# deviceId = sha256(raw-public-key) — the gateway derives it the same way.

# Regenerate if existing device.json uses the old UUID format
if [ -f "$DEVICE_FILE" ]; then
  OLD_ID="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${DEVICE_FILE}','utf8'));process.stdout.write(/^[0-9a-f]{64}$/.test(d.deviceId)?'ok':'bad')}catch{process.stdout.write('bad')}")"
  if [ "$OLD_ID" != "ok" ]; then
    echo "[entrypoint] Regenerating device identity (old format)..."
    rm -f "$DEVICE_FILE" "$PAIRED_FILE"
  fi
fi

if [ ! -f "$DEVICE_FILE" ]; then
  echo "[entrypoint] Generating device identity + pairing data..."
  mkdir -p "$IDENTITY_DIR" "$DEVICES_DIR"
  node -e "
    const crypto = require('crypto');
    const fs = require('fs');
    const { generateKeyPairSync, createPublicKey, createHash, randomBytes } = crypto;

    // Generate Ed25519 keypair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Derive deviceId = SHA256(raw public key)
    const spki = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const rawKey = spki.subarray(prefix.length);
    const deviceId = createHash('sha256').update(rawKey).digest('hex');

    // base64url-encode the raw public key (what the gateway stores)
    const pubKeyB64 = rawKey.toString('base64url');

    // 1) Write identity file (read by control-api)
    const identity = { deviceId, publicKeyPem: publicKey, privateKeyPem: privateKey };
    fs.writeFileSync('${DEVICE_FILE}', JSON.stringify(identity, null, 2) + '\n');

    // 2) Write paired.json (read by gateway on startup)
    const now = Date.now();
    const scopes = [
      'operator.admin', 'operator.approvals', 'operator.pairing',
      'operator.read', 'operator.write'
    ];
    const deviceToken = randomBytes(32).toString('hex');
    const paired = {
      [deviceId]: {
        deviceId,
        publicKey: pubKeyB64,
        displayName: 'docker-internal',
        platform: 'linux',
        clientId: 'gateway-client',
        clientMode: 'backend',
        role: 'operator',
        roles: ['operator'],
        scopes,
        approvedScopes: scopes,
        tokens: {
          operator: {
            token: deviceToken,
            role: 'operator',
            scopes,
            createdAtMs: now,
          }
        },
        createdAtMs: now,
        approvedAtMs: now,
      }
    };
    fs.writeFileSync('${PAIRED_FILE}', JSON.stringify(paired, null, 2) + '\n');

    // 3) Write device-auth.json (read by control-api for deviceToken)
    const deviceAuth = {
      deviceId,
      tokens: {
        operator: {
          token: deviceToken,
          scopes,
        }
      }
    };
    fs.writeFileSync('${IDENTITY_DIR}/device-auth.json', JSON.stringify(deviceAuth, null, 2) + '\n');

    console.log('[entrypoint] Device identity + pairing created: ' + deviceId);
  "
fi

# ── Generate an internal shared token for gateway ↔ control-api auth ────────
INTERNAL_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export OPENCLAW_GATEWAY_TOKEN="$INTERNAL_TOKEN"

# ── Start gateway ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting OpenClaw gateway on port ${GATEWAY_PORT}..."

openclaw --profile "$PROFILE" gateway run \
  --port "$GATEWAY_PORT" \
  --allow-unconfigured \
  --auth token \
  --bind loopback &

GATEWAY_PID=$!
sleep 2

echo "[entrypoint] Gateway started (PID ${GATEWAY_PID}). Starting control-api..."

# ── Start control-api ────────────────────────────────────────────────────────
if [ -f dist/index.mjs ]; then
  exec node dist/index.mjs
else
  exec node dist/index.js
fi
