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
DEVICE_AUTH_FILE="${IDENTITY_DIR}/device-auth.json"

# ── Generate device identity + pairing ───────────────────────────────────────
# The gateway requires:
#   1. device.json   — Ed25519 keypair (control-api reads this to sign connections)
#   2. paired.json   — pre-approved pairing data (gateway reads this at startup)
#   3. device-auth.json — device token (control-api sends this with connections)
#
# Locally the CLI bootstrap does all this interactively; here we do it
# before the gateway starts so everything is ready on first boot.
#
# deviceId = sha256(raw-public-key) — the gateway derives it the same way.

# Regenerate if existing device.json uses the old UUID format
if [ -f "$DEVICE_FILE" ]; then
  FMT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${DEVICE_FILE}','utf8'));process.stdout.write(/^[0-9a-f]{64}$/.test(d.deviceId)?'ok':'bad')}catch{process.stdout.write('bad')}")"
  if [ "$FMT" != "ok" ]; then
    echo "[entrypoint] Removing old-format device identity..."
    rm -f "$DEVICE_FILE" "$PAIRED_FILE" "$DEVICE_AUTH_FILE"
  fi
fi

# Generate device.json if missing
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
    const spki = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const rawKey = spki.subarray(prefix.length);
    const deviceId = createHash('sha256').update(rawKey).digest('hex');
    const identity = { deviceId, publicKeyPem: publicKey, privateKeyPem: privateKey };
    fs.writeFileSync('${DEVICE_FILE}', JSON.stringify(identity, null, 2) + '\n');
    console.log('[entrypoint] Device identity created: ' + deviceId);
  "
  # Force re-generation of pairing data when identity changes
  rm -f "$PAIRED_FILE" "$DEVICE_AUTH_FILE"
fi

# Generate paired.json + device-auth.json if missing
if [ ! -f "$PAIRED_FILE" ] || [ ! -f "$DEVICE_AUTH_FILE" ]; then
  echo "[entrypoint] Generating pairing data..."
  mkdir -p "$DEVICES_DIR"
  node -e "
    const crypto = require('crypto');
    const fs = require('fs');
    const identity = JSON.parse(fs.readFileSync('${DEVICE_FILE}', 'utf8'));
    const { deviceId, publicKeyPem } = identity;

    // Derive base64url-encoded raw public key
    const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const rawKey = spki.subarray(prefix.length);
    const pubKeyB64 = rawKey.toString('base64url');

    const now = Date.now();
    const scopes = [
      'operator.admin', 'operator.approvals', 'operator.pairing',
      'operator.read', 'operator.write'
    ];
    const deviceToken = crypto.randomBytes(32).toString('hex');

    // paired.json — gateway reads this at startup
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

    // device-auth.json — control-api reads this for the device token
    const deviceAuth = {
      deviceId,
      tokens: { operator: { token: deviceToken, scopes } }
    };
    fs.writeFileSync('${DEVICE_AUTH_FILE}', JSON.stringify(deviceAuth, null, 2) + '\n');

    console.log('[entrypoint] Pairing data created for device: ' + deviceId);
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
  --bind loopback \
  --dev \
  --verbose &

GATEWAY_PID=$!
sleep 2

echo "[entrypoint] Gateway started (PID ${GATEWAY_PID}). Starting control-api..."

# ── Start control-api ────────────────────────────────────────────────────────
if [ -f dist/index.mjs ]; then
  exec node dist/index.mjs
else
  exec node dist/index.js
fi
