/**
 * Gateway WebSocket RPC client — ported from apps/web/lib/agent-runner.ts
 *
 * Provides `callGatewayRpc()` for one-shot RPC calls to the gateway,
 * plus the lower-level primitives (`GatewayWsClient`, `openGatewayClient`,
 * `buildConnectParams`) needed by the chat/streaming layer (Phase 3e).
 */
import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import NodeWebSocket from "ws";

import { resolveOpenClawStateDir } from "./workspace-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GatewayReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

export type GatewayEventFrame = {
  type: "event";
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayFrame =
  | GatewayReqFrame
  | GatewayResFrame
  | GatewayEventFrame
  | { type?: string; [key: string]: unknown };

export type GatewayConnectionSettings = {
  url: string;
  token?: string;
  password?: string;
};

type PendingGatewayRequest = {
  resolve: (value: GatewayResFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BuildConnectParamsOptions = {
  clientMode?: "webchat" | "backend" | "cli" | "ui" | "node" | "probe" | "test";
  caps?: string[];
  nonce?: string;
  deviceIdentity?: DeviceIdentity | null;
  deviceToken?: string | null;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type DeviceAuth = {
  deviceId: string;
  token: string;
  scopes: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_PORT = 18_789;
const OPEN_TIMEOUT_MS = 8_000;
const CHALLENGE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_GATEWAY_CLIENT_CAPS = ["tool-events"];
const GATEWAY_RPC_RETRY_BASE_MS = 250;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RETRYABLE_GATEWAY_CLOSE_CODES = new Set([1000, 1005, 1006, 1012]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parsePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

export function loadDeviceIdentity(stateDir: string): DeviceIdentity | null {
  const filePath = join(stateDir, "identity", "device.json");
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
    if (
      parsed &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKeyPem === "string" &&
      typeof parsed.privateKeyPem === "string"
    ) {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
  } catch { /* ignore */ }
  return null;
}

export function loadDeviceAuth(stateDir: string): DeviceAuth | null {
  const filePath = join(stateDir, "identity", "device-auth.json");
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed.deviceId !== "string") return null;
    const tokens = asRecord(parsed.tokens);
    const operator = asRecord(tokens?.operator);
    if (operator && typeof operator.token === "string") {
      return {
        deviceId: parsed.deviceId,
        token: operator.token,
        scopes: Array.isArray(operator.scopes) ? (operator.scopes as string[]) : [],
      };
    }
  } catch { /* ignore */ }
  return null;
}

function toMessageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gateway URL resolution
// ---------------------------------------------------------------------------

function normalizeWsUrl(raw: string, fallbackPort: number): string {
  const withScheme = raw.includes("://") ? raw : `ws://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (!url.port) url.port = url.protocol === "wss:" ? "443" : String(fallbackPort);
  return url.toString();
}

function readGatewayConfigFromStateDir(stateDir: string): Record<string, unknown> | null {
  const candidates = [join(stateDir, "openclaw.json"), join(stateDir, "config.json")];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = parseJsonObject(readFileSync(candidate, "utf-8"));
      if (parsed) return parsed;
    } catch { /* ignore */ }
  }
  return null;
}

export function resolveGatewayConnectionCandidates(): GatewayConnectionSettings[] {
  const envUrl = process.env.OPENCLAW_GATEWAY_URL?.trim();
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const envPassword = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const envPort = parsePort(process.env.OPENCLAW_GATEWAY_PORT);

  const stateDir = resolveOpenClawStateDir();
  const config = readGatewayConfigFromStateDir(stateDir);
  const gateway = asRecord(config?.gateway);
  const remote = asRecord(gateway?.remote);
  const auth = asRecord(gateway?.auth);

  const configGatewayPort = parsePort(gateway?.port) ?? DEFAULT_GATEWAY_PORT;
  const gatewayPort = envPort ?? configGatewayPort;
  const gatewayMode =
    typeof gateway?.mode === "string" ? gateway.mode.trim().toLowerCase() : "";
  const remoteUrl =
    typeof remote?.url === "string" ? remote.url.trim() : undefined;
  const useRemote = !envUrl && gatewayMode === "remote" && Boolean(remoteUrl);

  const configToken =
    (useRemote && typeof remote?.token === "string" ? remote.token.trim() : undefined) ||
    (typeof auth?.token === "string" ? auth.token.trim() : undefined);

  const configPassword =
    (useRemote && typeof remote?.password === "string" ? remote.password.trim() : undefined) ||
    (typeof auth?.password === "string" ? auth.password.trim() : undefined);

  const primaryRawUrl = envUrl || (useRemote ? remoteUrl! : `ws://127.0.0.1:${gatewayPort}`);
  const primary: GatewayConnectionSettings = {
    url: normalizeWsUrl(primaryRawUrl, gatewayPort),
    token: envToken || configToken,
    password: envPassword || configPassword,
  };

  const configRawUrl = useRemote ? remoteUrl! : `ws://127.0.0.1:${configGatewayPort}`;
  const fallback: GatewayConnectionSettings = {
    url: normalizeWsUrl(configRawUrl, configGatewayPort),
    token: configToken,
    password: configPassword,
  };

  const result = [primary];
  if (fallback.url !== primary.url) result.push(fallback);

  const deduped: GatewayConnectionSettings[] = [];
  const seen = new Set<string>();
  for (const candidate of result) {
    const key = `${candidate.url}|${candidate.token ?? ""}|${candidate.password ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// buildConnectParams
// ---------------------------------------------------------------------------

export function buildConnectParams(
  settings: GatewayConnectionSettings,
  options?: BuildConnectParamsOptions,
): Record<string, unknown> {
  const optionCaps = options?.caps;
  const caps = Array.isArray(optionCaps)
    ? optionCaps.filter((cap): cap is string => typeof cap === "string" && cap.trim().length > 0)
    : DEFAULT_GATEWAY_CLIENT_CAPS;
  const clientMode = options?.clientMode ?? "backend";
  const clientId = process.env.OPENCLAW_GATEWAY_CLIENT_ID || "gateway-client";
  const role = "operator";
  const scopes = [
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
    "operator.read",
    "operator.write",
  ];

  const hasGatewayAuth = Boolean(settings.token || settings.password);
  const deviceToken = options?.deviceToken;
  const auth = hasGatewayAuth || deviceToken
    ? {
        ...(settings.token ? { token: settings.token } : {}),
        ...(settings.password ? { password: settings.password } : {}),
        ...(deviceToken ? { deviceToken } : {}),
      }
    : undefined;

  const nonce = options?.nonce;
  const identity = options?.deviceIdentity;
  let device: Record<string, unknown> | undefined;
  if (identity && nonce) {
    const signedAtMs = Date.now();
    const platform = process.platform;
    const payload = [
      "v3",
      identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes.join(","),
      String(signedAtMs),
      settings.token ?? "",
      nonce,
      platform,
      "",
    ].join("|");
    const signature = signDevicePayload(identity.privateKeyPem, payload);
    device = {
      id: identity.deviceId,
      publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
      signature,
      signedAt: signedAtMs,
      nonce,
    };
  }

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      version: "dev",
      platform: process.platform,
      mode: clientMode,
      instanceId: "denchclaw-control-api",
    },
    locale: "en-US",
    userAgent: "denchclaw-control-api",
    role,
    scopes,
    caps,
    ...(auth ? { auth } : {}),
    ...(device ? { device } : {}),
  };
}

// ---------------------------------------------------------------------------
// Error helpers (exported for GatewayProcessHandle in Phase 3e)
// ---------------------------------------------------------------------------

export function frameErrorMessage(frame: GatewayResFrame): string {
  const error = asRecord(frame.error);
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof frame.error === "string" && frame.error.trim()) return frame.error;
  return "Gateway request failed";
}

export function isUnknownMethodResponse(frame: GatewayResFrame, methodName: string): boolean {
  const message = frameErrorMessage(frame).trim().toLowerCase();
  if (!message.includes("unknown method")) return false;
  return message.includes(methodName.toLowerCase());
}

export function isRetryableGatewayMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("temporar") ||
    normalized.includes("unavailable") ||
    normalized.includes("try again") ||
    normalized.includes("connection closed") ||
    normalized.includes("connection reset")
  );
}

export function isRetryableGatewayCloseCode(code: number): boolean {
  return RETRYABLE_GATEWAY_CLOSE_CODES.has(code);
}

export function isRetryableGatewayTransportError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("gateway connection closed") ||
    normalized.includes("gateway websocket connection failed") ||
    normalized.includes("gateway websocket open timeout") ||
    normalized.includes("code 1000") ||
    normalized.includes("code 1005") ||
    normalized.includes("code 1006") ||
    normalized.includes("code 1012") ||
    normalized.includes("closed (1000") ||
    normalized.includes("closed (1005") ||
    normalized.includes("closed (1006") ||
    normalized.includes("closed (1012")
  );
}

const MISSING_SCOPE_RE = /missing scope:\s*(\S+)/i;

export function enhanceScopeError(raw: string): string | null {
  const match = MISSING_SCOPE_RE.exec(raw);
  if (!match) return null;
  const scope = match[1];
  return [
    `missing scope: ${scope}.`,
    "The Gateway did not grant operator scopes — device identity may be missing or invalid.",
    "Fix: run `npx denchclaw bootstrap` to re-pair the device.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// GatewayWsClient
// ---------------------------------------------------------------------------

export class GatewayWsClient {
  private ws: NodeWebSocket | null = null;
  private pending = new Map<string, PendingGatewayRequest>();
  private closed = false;
  private challengeNonce: string | null = null;
  private challengeResolve: ((nonce: string) => void) | null = null;

  constructor(
    private readonly settings: GatewayConnectionSettings,
    private readonly onEvent: (frame: GatewayEventFrame) => void,
    private readonly onClose: (code: number, reason: string) => void,
  ) {}

  waitForChallenge(timeoutMs = CHALLENGE_TIMEOUT_MS): Promise<string> {
    if (this.challengeNonce) return Promise.resolve(this.challengeNonce);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeResolve = null;
        reject(new Error("Gateway challenge timeout"));
      }, timeoutMs);
      this.challengeResolve = (nonce: string) => {
        clearTimeout(timer);
        resolve(nonce);
      };
    });
  }

  async open(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
    if (this.ws) return;
    const ws = new NodeWebSocket(this.settings.url, { origin: this.settings.url });
    this.ws = ws;

    ws.on("message", (data: NodeWebSocket.RawData) => {
      const text = toMessageText(data);
      if (text != null) this.handleMessageText(text);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.closed) return;
      this.closed = true;
      this.flushPending(new Error("Gateway connection closed"));
      this.onClose(code, reason.toString("utf-8"));
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Gateway WebSocket open timeout"));
      }, timeoutMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Gateway WebSocket connection failed"));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<GatewayResFrame> {
    const ws = this.ws;
    if (!ws || ws.readyState !== NodeWebSocket.OPEN) {
      return Promise.reject(new Error("Gateway WebSocket is not connected"));
    }
    return new Promise<GatewayResFrame>((resolve, reject) => {
      const id = randomUUID();
      const frame: GatewayReqFrame = { type: "req", id, method, params };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.flushPending(new Error("Gateway connection closed"));
    try {
      this.ws?.close(code, reason);
    } catch { /* ignore */ }
  }

  private flushPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private _msgCount = 0;
  private handleMessageText(text: string): void {
    this._msgCount++;
    // Debug: log event-type messages (skip tick/health noise). Log first 20 messages always.
    if (this._msgCount <= 20 || (!text.includes('"tick"') && !text.includes('"health"') && !text.includes('"presence"'))) {
      console.log(`[GatewayWsClient] msg#${this._msgCount}: ${text.slice(0, 400)}`);
    }
    let frame: GatewayFrame | null = null;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) return;

    if (frame.type === "res") {
      const response = frame as GatewayResFrame;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
      return;
    }

    if (frame.type === "event") {
      const evt = frame as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = asRecord(evt.payload);
        const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : null;
        if (nonce) {
          this.challengeNonce = nonce;
          this.challengeResolve?.(nonce);
          this.challengeResolve = null;
        }
        return;
      }
      this.onEvent(evt);
    }
  }
}

// ---------------------------------------------------------------------------
// openGatewayClient — connect, authenticate, return ready client
// ---------------------------------------------------------------------------

export async function openGatewayClient(
  onEvent: (frame: GatewayEventFrame) => void,
  onClose: (code: number, reason: string) => void,
): Promise<{ client: GatewayWsClient; settings: GatewayConnectionSettings }> {
  const candidates = resolveGatewayConnectionCandidates();
  let lastError: Error | null = null;
  for (const settings of candidates) {
    const client = new GatewayWsClient(settings, onEvent, onClose);
    try {
      await client.open();
      return { client, settings };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      client.close();
    }
  }
  throw lastError ?? new Error("Gateway WebSocket connection failed");
}

// ---------------------------------------------------------------------------
// callGatewayRpc — one-shot authenticated RPC (with retry)
// ---------------------------------------------------------------------------

async function callGatewayRpcOnce(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<GatewayResFrame> {
  let closed = false;
  const { client, settings } = await openGatewayClient(
    () => {},
    () => { closed = true; },
  );
  try {
    const stateDir = resolveOpenClawStateDir();
    const deviceIdentity = loadDeviceIdentity(stateDir);
    const deviceAuth = loadDeviceAuth(stateDir);

    let nonce: string | undefined;
    if (deviceIdentity) {
      try {
        nonce = await client.waitForChallenge();
      } catch {
        nonce = undefined;
      }
    }

    const connect = await client.request(
      "connect",
      buildConnectParams(settings, { nonce, deviceIdentity, deviceToken: deviceAuth?.token }),
      options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    if (!connect.ok) throw new Error(frameErrorMessage(connect));
    return await client.request(method, params, options?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  } finally {
    if (!closed) client.close();
  }
}

export async function callGatewayRpc(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number; retries?: number },
): Promise<GatewayResFrame> {
  const retries = Math.max(0, Number.isFinite(options?.retries) ? Number(options?.retries) : 2);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await callGatewayRpcOnce(method, params, options);
    } catch (error) {
      lastError = error;
      const raw = error instanceof Error ? error.message : String(error);
      if (attempt >= retries || !isRetryableGatewayTransportError(raw)) throw error;
      const delay = Math.min(2_000, GATEWAY_RPC_RETRY_BASE_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(lastError == null ? "Gateway RPC failed" : String(lastError));
}
