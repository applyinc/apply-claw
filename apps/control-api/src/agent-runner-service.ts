/**
 * Agent runner service — ported from apps/web/lib/agent-runner.ts
 *
 * Contains GatewayProcessHandle, spawn functions, and event-parsing helpers.
 * The lower-level WebSocket primitives live in gateway-rpc-client.ts.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  type GatewayConnectionSettings,
  type GatewayEventFrame,
  type GatewayResFrame,
  GatewayWsClient,
  openGatewayClient,
  buildConnectParams,
  loadDeviceIdentity,
  loadDeviceAuth,
  frameErrorMessage,
  isUnknownMethodResponse,
  isRetryableGatewayMessage,
  isRetryableGatewayCloseCode,
  isRetryableGatewayTransportError,
  enhanceScopeError,
} from "./gateway-rpc-client.js";
import { resolveOpenClawStateDir, resolveActiveAgentId } from "./workspace-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentEvent = {
  event: string;
  runId?: string;
  stream?: string;
  data?: Record<string, unknown>;
  seq?: number;
  globalSeq?: number;
  ts?: number;
  sessionKey?: string;
  status?: string;
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
    meta?: Record<string, unknown>;
  };
};

export type ToolResult = {
  text?: string;
  details?: Record<string, unknown>;
};

export type AgentProcessHandle = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: {
    (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): AgentProcessHandle;
    (event: string, listener: (...args: unknown[]) => void): AgentProcessHandle;
  };
  once: {
    (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): AgentProcessHandle;
    (event: string, listener: (...args: unknown[]) => void): AgentProcessHandle;
  };
};

type SpawnGatewayProcessParams = {
  mode: "start" | "subscribe";
  message?: string;
  sessionKey?: string;
  afterSeq: number;
  lane?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_PATCH_RETRY_DELAY_MS = 150;
const SESSIONS_PATCH_MAX_ATTEMPTS = 2;
const LIFECYCLE_ERROR_RECOVERY_MS = 15_000;
const GATEWAY_RECONNECT_BASE_MS = 300;
const GATEWAY_RECONNECT_MAX_MS = 5_000;
const GATEWAY_RECONNECT_MAX_ATTEMPTS = 6;

type AgentSubscribeSupport = "unknown" | "supported" | "unsupported";
let cachedAgentSubscribeSupport: AgentSubscribeSupport = "unknown";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractToolResult(raw: unknown): ToolResult | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return { text: raw, details: undefined };
  if (typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  const content = Array.isArray(r.content) ? r.content : [];
  const textParts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string") {
      textParts.push((block as Record<string, unknown>).text as string);
    }
  }

  const text = textParts.length > 0 ? textParts.join("\n") : undefined;
  const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : undefined;

  if (!text && !details && !Array.isArray(r.content)) {
    return { text: undefined, details: r };
  }
  return { text, details };
}

export function buildToolOutput(result?: ToolResult): Record<string, unknown> {
  if (!result) return {};
  const out: Record<string, unknown> = {};
  if (result.text) out.text = result.text;
  if (result.details) {
    for (const [key, value] of Object.entries(result.details)) {
      if (value !== undefined) out[key] = value;
    }
  }
  if (!out.text && result.details) {
    try {
      const json = JSON.stringify(result.details);
      if (json.length <= 50_000) out.text = json;
    } catch { /* ignore */ }
  }
  return out;
}

export function parseAgentErrorMessage(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  if (typeof data.error === "string") return parseErrorBody(data.error);
  if (typeof data.error === "object" && data.error !== null) {
    const nested = data.error as Record<string, unknown>;
    if (typeof nested.message === "string") return parseErrorBody(nested.message);
  }
  if (typeof data.message === "string") return parseErrorBody(data.message);
  if (typeof data.errorMessage === "string") return parseErrorBody(data.errorMessage);
  if (typeof data.detail === "string") return parseErrorBody(data.detail);
  if (typeof data.reason === "string") return parseErrorBody(data.reason);
  if (typeof data.description === "string") return parseErrorBody(data.description);
  if (typeof data.code === "string" && data.code.trim()) return data.code;
  try {
    const json = JSON.stringify(data);
    if (json !== "{}" && json.length <= 500) return json;
    if (json.length > 500) return `${json.slice(0, 497)}...`;
  } catch { /* ignore */ }
  return undefined;
}

export function parseErrorBody(raw: string): string {
  if (raw === "terminated") {
    return "Agent run was terminated by the gateway. This is usually caused by the model provider dropping the connection mid-stream. Retry the message to continue.";
  }
  const jsonIdx = raw.indexOf("{");
  if (jsonIdx >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonIdx));
      const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof msg === "string") return msg;
    } catch { /* not valid JSON */ }
  }
  return raw;
}

export function parseErrorFromStderr(stderr: string): string | undefined {
  if (!stderr) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = stderr.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  const jsonMatch = clean.match(/\{"error":\{[^}]*"message":"([^"]+)"[^}]*\}/);
  if (jsonMatch?.[1]) return jsonMatch[1];
  const lines = clean.split("\n").filter(Boolean);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\b(error|failed|fatal)\b/i.test(trimmed)) {
      const stripped = trimmed.replace(/^\[.*?\]\s*/, "").replace(/^Error:\s*/i, "");
      if (stripped.length > 5) return stripped;
    }
  }
  const last = lines[lines.length - 1]?.trim();
  if (last && last.length <= 300) return last;
  return undefined;
}

// ---------------------------------------------------------------------------
// GatewayProcessHandle
// ---------------------------------------------------------------------------

class GatewayProcessHandle extends EventEmitter implements AgentProcessHandle {
  public readonly stdout: NodeJS.ReadableStream | null = new PassThrough();
  public readonly stderr: NodeJS.ReadableStream | null = new PassThrough();
  private client: GatewayWsClient | null = null;
  private finished = false;
  private closeScheduled = false;
  private requestedClose = false;
  private runId: string | null = null;
  private lifecycleErrorCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleErrorRecoveryUntil = 0;
  private useChatSend = false;
  private receivedAgentEvent = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastGlobalSeq = 0;
  private replayFloorSeq = 0;
  private sessionStarted = false;
  private readonly startIdempotencyKey = randomUUID();

  constructor(private readonly params: SpawnGatewayProcessParams) {
    super();
    const initialSeq = Math.max(0, Number.isFinite(params.afterSeq) ? params.afterSeq : 0);
    this.lastGlobalSeq = initialSeq;
    this.replayFloorSeq = initialSeq;
    void this.start();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.finished) return false;
    this.requestedClose = true;
    this.clearReconnectTimer();
    this.clearLifecycleErrorCloseTimer();
    this.client?.close();
    const closeSignal = typeof signal === "string" ? signal : null;
    this.finish(0, closeSignal);
    return true;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resetReconnectState(): void {
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
  }

  private retryMode(): "start" | "subscribe" | "resume" {
    if (this.params.mode === "start") {
      return this.sessionStarted && Boolean(this.params.sessionKey) ? "resume" : "start";
    }
    return this.sessionStarted ? "resume" : "subscribe";
  }

  private shouldScheduleReconnect(detail: string, code?: number): boolean {
    if (this.finished || this.requestedClose || this.closeScheduled) return false;
    if (typeof code === "number" && !isRetryableGatewayCloseCode(code)) return false;
    if (!isRetryableGatewayTransportError(detail)) return false;
    if (this.reconnectAttempt >= GATEWAY_RECONNECT_MAX_ATTEMPTS) return false;
    const mode = this.retryMode();
    if (mode === "resume") return Boolean(this.params.sessionKey);
    if (mode === "subscribe") return Boolean(this.params.sessionKey);
    return typeof this.params.message === "string";
  }

  private scheduleReconnect(detail: string, code?: number): boolean {
    if (!this.shouldScheduleReconnect(detail, code)) return false;
    if (this.reconnectTimer) return true;
    this.clearLifecycleErrorCloseTimer();
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
    this.replayFloorSeq = Math.max(this.replayFloorSeq, this.lastGlobalSeq);
    const delay = Math.min(GATEWAY_RECONNECT_MAX_MS, GATEWAY_RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectAfterDrop();
    }, delay);
    return true;
  }

  private async openAndAuthenticate(): Promise<void> {
    const { client, settings } = await openGatewayClient(
      (frame) => this.handleGatewayEvent(frame),
      (code, reason) => this.handleSocketClose(code, reason),
    );
    this.client = client;
    try {
      const stateDir = resolveOpenClawStateDir();
      const deviceIdentity = loadDeviceIdentity(stateDir);
      const deviceAuth = loadDeviceAuth(stateDir);
      let nonce: string | undefined;
      if (deviceIdentity) {
        try { nonce = await client.waitForChallenge(); } catch { nonce = undefined; }
      }
      const connectParams = buildConnectParams(settings, { nonce, deviceIdentity, deviceToken: deviceAuth?.token });
      const connectRes = await client.request("connect", connectParams);
      if (!connectRes.ok) throw new Error(frameErrorMessage(connectRes));
    } catch (error) {
      this.client = null;
      client.close();
      throw error;
    }
  }

  private async beginStartMode(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("Gateway WebSocket is not connected");
    if (this.params.sessionKey) {
      await this.ensureFullToolVerbose(this.params.sessionKey);
    }
    const sessionKey = this.params.sessionKey;
    const msg = this.params.message ?? "";
    this.useChatSend = true;

    let startRes: GatewayResFrame;
    if (this.useChatSend) {
      startRes = await client.request("chat.send", {
        message: msg,
        ...(sessionKey ? { sessionKey } : {}),
        idempotencyKey: this.startIdempotencyKey,
        deliver: false,
      });
    } else {
      startRes = await client.request("agent", {
        message: msg,
        idempotencyKey: this.startIdempotencyKey,
        ...(sessionKey ? { sessionKey } : {}),
        deliver: false,
        channel: "webchat",
        lane: this.params.lane ?? "web",
        timeout: 0,
      });
    }
    if (!startRes.ok) throw new Error(frameErrorMessage(startRes));
    const payload = asRecord(startRes.payload);
    const runId = payload && typeof payload.runId === "string" ? payload.runId : null;
    this.runId = runId;
    this.sessionStarted = true;
    if (sessionKey) await this.ensureFullToolVerbose(sessionKey);
  }

  private async beginSubscribeMode(afterSeq: number): Promise<void> {
    const client = this.client;
    const sessionKey = this.params.sessionKey;
    if (!client) throw new Error("Gateway WebSocket is not connected");
    if (!sessionKey) throw new Error("Missing session key for subscribe mode");
    const effectiveAfterSeq = Math.max(0, Number.isFinite(afterSeq) ? afterSeq : 0);
    this.replayFloorSeq = effectiveAfterSeq;
    await this.ensureFullToolVerbose(sessionKey);
    if (cachedAgentSubscribeSupport !== "unsupported") {
      const subscribeRes = await client.request("agent.subscribe", { sessionKey, afterSeq: effectiveAfterSeq });
      if (!subscribeRes.ok) {
        if (isUnknownMethodResponse(subscribeRes, "agent.subscribe")) {
          cachedAgentSubscribeSupport = "unsupported";
          (this.stderr as PassThrough).write("[gateway] agent.subscribe unavailable; using passive session filter mode\n");
        } else {
          throw new Error(frameErrorMessage(subscribeRes));
        }
      } else {
        cachedAgentSubscribeSupport = "supported";
      }
    }
    this.sessionStarted = true;
  }

  private async reconnectAfterDrop(): Promise<void> {
    if (this.finished || this.requestedClose) return;
    console.log(`[GatewayProcessHandle] reconnectAfterDrop attempt=${this.reconnectAttempt}`);
    try {
      await this.openAndAuthenticate();
      const mode = this.retryMode();
      if (mode === "start") await this.beginStartMode();
      else await this.beginSubscribeMode(this.replayFloorSeq);
      this.resetReconnectState();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[GatewayProcessHandle] reconnect FAILED: ${raw}`);
      if (this.scheduleReconnect(raw)) return;
      const enhanced = enhanceScopeError(raw);
      const err = new Error(enhanced ?? raw);
      (this.stderr as PassThrough).write(`${err.message}\n`);
      this.emit("error", err);
      this.finish(1, null);
    }
  }

  private async start(): Promise<void> {
    console.log(`[GatewayProcessHandle] start() mode=${this.params.mode} sessionKey=${this.params.sessionKey ?? "none"}`);
    try {
      console.log("[GatewayProcessHandle] openAndAuthenticate...");
      await this.openAndAuthenticate();
      console.log("[GatewayProcessHandle] openAndAuthenticate OK");
      if (this.params.mode === "start") {
        console.log("[GatewayProcessHandle] beginStartMode...");
        await this.beginStartMode();
        console.log("[GatewayProcessHandle] beginStartMode OK, runId=", this.runId);
      } else {
        await this.beginSubscribeMode(this.params.afterSeq);
      }
      this.resetReconnectState();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[GatewayProcessHandle] start() FAILED: ${raw}`);
      if (this.scheduleReconnect(raw)) {
        console.log(`[GatewayProcessHandle] scheduled reconnect attempt=${this.reconnectAttempt}`);
        return;
      }
      const enhanced = enhanceScopeError(raw);
      const err = new Error(enhanced ?? raw);
      console.error(`[GatewayProcessHandle] FATAL error (no more retries): ${err.message}`);
      (this.stderr as PassThrough).write(`${err.message}\n`);
      this.emit("error", err);
      this.finish(1, null);
    }
  }

  private async ensureFullToolVerbose(sessionKey: string): Promise<void> {
    if (!this.client || !sessionKey.trim()) return;
    const patchParams: Record<string, string> = { key: sessionKey, thinkingLevel: "high", verboseLevel: "full", reasoningLevel: "on" };
    let attempt = 0;
    let lastMessage = "";
    while (attempt < SESSIONS_PATCH_MAX_ATTEMPTS) {
      attempt += 1;
      try {
        const patch = await this.client.request("sessions.patch", patchParams);
        if (patch.ok) return;
        lastMessage = frameErrorMessage(patch);
        if (lastMessage.includes("thinkingLevel") && patchParams.thinkingLevel) {
          delete patchParams.thinkingLevel;
          attempt = 0;
          continue;
        }
        if (attempt >= SESSIONS_PATCH_MAX_ATTEMPTS || !isRetryableGatewayMessage(lastMessage)) break;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
        if (lastMessage.includes("thinkingLevel") && patchParams.thinkingLevel) {
          delete patchParams.thinkingLevel;
          attempt = 0;
          continue;
        }
        if (attempt >= SESSIONS_PATCH_MAX_ATTEMPTS || !isRetryableGatewayMessage(lastMessage)) break;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSIONS_PATCH_RETRY_DELAY_MS));
    }
    if (lastMessage.trim()) {
      (this.stderr as PassThrough).write(`[gateway] sessions.patch verboseLevel=full failed: ${lastMessage}\n`);
    }
  }

  private shouldAcceptSessionEvent(sessionKey: string | undefined): boolean {
    const expected = this.params.sessionKey;
    if (!expected) return true;
    if (this.params.mode === "subscribe") return sessionKey === expected;
    if (!sessionKey) return true;
    return sessionKey === expected;
  }

  private handleGatewayEvent(frame: GatewayEventFrame): void {
    if (this.finished) return;
    if (frame.event === "connect.challenge") return;

    if (frame.event === "agent") {
      this.receivedAgentEvent = true;
      const payload = asRecord(frame.payload);
      if (!payload) return;
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
      if (!this.shouldAcceptSessionEvent(sessionKey)) return;
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;
      if (this.runId && runId && runId !== this.runId) {
        if (Date.now() <= this.lifecycleErrorRecoveryUntil) {
          this.runId = runId;
          this.clearLifecycleErrorCloseTimer();
        } else {
          return;
        }
      }
      const payloadGlobalSeq = typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
      const eventGlobalSeq = payloadGlobalSeq ?? (typeof frame.seq === "number" ? frame.seq : undefined);
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq <= this.replayFloorSeq) return;
      this.sessionStarted = true;
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq > this.lastGlobalSeq) this.lastGlobalSeq = eventGlobalSeq;

      const event: AgentEvent = {
        event: "agent",
        ...(runId ? { runId } : {}),
        ...(typeof payload.stream === "string" ? { stream: payload.stream } : {}),
        ...(asRecord(payload.data) ? { data: payload.data as Record<string, unknown> } : {}),
        ...(typeof payload.seq === "number" ? { seq: payload.seq } : {}),
        ...(typeof eventGlobalSeq === "number" ? { globalSeq: eventGlobalSeq } : {}),
        ...(typeof payload.ts === "number" ? { ts: payload.ts } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      };

      (this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);

      const stream = typeof payload.stream === "string" ? payload.stream : "";
      const data = asRecord(payload.data);
      const phase = data && typeof data.phase === "string" ? data.phase : "";
      if (this.params.mode === "start" && this.params.sessionKey?.includes(":web:") && stream === "tool" && phase === "result" && typeof data?.name === "string" && data.name === "sessions_yield" && sessionKey === this.params.sessionKey) {
        this.scheduleClose();
      }
      if (!(stream === "lifecycle" && phase === "error")) this.clearLifecycleErrorCloseTimer();
      if (this.params.mode === "start" && stream === "lifecycle" && phase === "end") this.scheduleClose();
      if (this.params.mode === "start" && stream === "lifecycle" && phase === "error") this.armLifecycleErrorCloseTimer();
      return;
    }

    if (frame.event === "chat") {
      const payload = asRecord(frame.payload) ?? {};
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
      const forwardChat = this.params.mode === "subscribe" || (this.useChatSend && !this.receivedAgentEvent);
      if (!forwardChat) return;
      if (!this.shouldAcceptSessionEvent(sessionKey)) return;
      const payloadGlobalSeq = typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
      const eventGlobalSeq = payloadGlobalSeq ?? (typeof frame.seq === "number" ? frame.seq : undefined);
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq <= this.replayFloorSeq) return;
      this.sessionStarted = true;
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq > this.lastGlobalSeq) this.lastGlobalSeq = eventGlobalSeq;
      const event: AgentEvent = {
        event: "chat",
        data: payload,
        ...(typeof eventGlobalSeq === "number" ? { globalSeq: eventGlobalSeq } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      };
      (this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
      if (this.useChatSend && this.params.mode === "start" && typeof payload.state === "string" && payload.state === "final") {
        this.scheduleClose();
      }
      return;
    }

    if (frame.event === "error") {
      const payload = asRecord(frame.payload) ?? {};
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
      if (!this.shouldAcceptSessionEvent(sessionKey)) return;
      const payloadGlobalSeq = typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
      const eventGlobalSeq = payloadGlobalSeq ?? (typeof frame.seq === "number" ? frame.seq : undefined);
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq <= this.replayFloorSeq) return;
      this.sessionStarted = true;
      if (typeof eventGlobalSeq === "number" && eventGlobalSeq > this.lastGlobalSeq) this.lastGlobalSeq = eventGlobalSeq;
      const event: AgentEvent = {
        event: "error",
        data: payload,
        ...(typeof eventGlobalSeq === "number" ? { globalSeq: eventGlobalSeq } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      };
      (this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
      if (this.params.mode === "start") this.armLifecycleErrorCloseTimer();
    }
  }

  private armLifecycleErrorCloseTimer(): void {
    this.lifecycleErrorRecoveryUntil = Date.now() + LIFECYCLE_ERROR_RECOVERY_MS;
    this.clearLifecycleErrorCloseTimer();
    this.lifecycleErrorCloseTimer = setTimeout(() => {
      this.lifecycleErrorCloseTimer = null;
      if (this.finished) return;
      this.scheduleClose();
    }, LIFECYCLE_ERROR_RECOVERY_MS);
  }

  private clearLifecycleErrorCloseTimer(): void {
    this.lifecycleErrorRecoveryUntil = 0;
    if (!this.lifecycleErrorCloseTimer) return;
    clearTimeout(this.lifecycleErrorCloseTimer);
    this.lifecycleErrorCloseTimer = null;
  }

  private scheduleClose(): void {
    if (this.closeScheduled || this.finished) return;
    this.closeScheduled = true;
    this.clearReconnectTimer();
    setTimeout(() => {
      if (this.finished) return;
      this.requestedClose = true;
      this.client?.close();
      this.finish(0, null);
    }, 25);
  }

  private handleSocketClose(code: number, reason: string): void {
    console.log(`[GatewayProcessHandle] handleSocketClose code=${code} reason="${reason}" finished=${this.finished}`);
    if (this.finished) return;
    this.client = null;
    if (this.closeScheduled) {
      this.requestedClose = true;
      this.finish(0, null);
      return;
    }
    const detail = reason.trim() || `code ${code}`;
    if (this.scheduleReconnect(detail, code)) {
      console.log(`[GatewayProcessHandle] socket close → scheduled reconnect attempt=${this.reconnectAttempt}`);
      return;
    }
    if (!this.requestedClose) {
      (this.stderr as PassThrough).write(`Gateway connection closed: ${detail}\n`);
    }
    const exitCode = this.requestedClose ? 0 : 1;
    this.finish(exitCode, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    this.clearReconnectTimer();
    this.clearLifecycleErrorCloseTimer();
    this.client = null;
    try {
      (this.stdout as PassThrough).end();
      (this.stderr as PassThrough).end();
    } catch { /* ignore */ }
    this.emit("close", code, signal);
  }
}

// ---------------------------------------------------------------------------
// Spawn functions
// ---------------------------------------------------------------------------

export function spawnAgentProcess(
  message: string,
  agentSessionId?: string,
  overrideAgentId?: string,
): AgentProcessHandle {
  const agentId = overrideAgentId ?? resolveActiveAgentId();
  const sessionKey = agentSessionId ? `agent:${agentId}:web:${agentSessionId}` : undefined;
  return new GatewayProcessHandle({
    mode: "start",
    message,
    sessionKey,
    afterSeq: 0,
    lane: agentSessionId ? `web:${agentSessionId}` : "web",
  });
}

export function spawnAgentSubscribeProcess(sessionKey: string, afterSeq = 0): AgentProcessHandle {
  return new GatewayProcessHandle({
    mode: "subscribe",
    sessionKey,
    afterSeq: Math.max(0, Number.isFinite(afterSeq) ? afterSeq : 0),
  });
}

export function spawnAgentStartForSession(message: string, sessionKey: string): AgentProcessHandle {
  return new GatewayProcessHandle({
    mode: "start",
    message,
    sessionKey,
    afterSeq: 0,
    lane: "subagent",
  });
}
