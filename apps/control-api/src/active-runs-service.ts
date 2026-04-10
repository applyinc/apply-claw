/**
 * Server-side singleton that manages agent child processes independently of
 * HTTP connections. Buffers SSE events, fans out to subscribers, and
 * persists assistant messages incrementally to disk.
 *
 * Ported from apps/web/lib/active-runs.ts
 */
import { createInterface } from "node:readline";
import { join, resolve as resolvePath, basename } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  resolveWebChatDir,
  resolveOpenClawStateDir,
  resolveActiveAgentId,
  resolveAgentWorkspacePrefix,
} from "./workspace-service.js";
import {
  type AgentProcessHandle,
  type AgentEvent,
  spawnAgentProcess,
  spawnAgentSubscribeProcess,
  spawnAgentStartForSession,
  extractToolResult,
  buildToolOutput,
  parseAgentErrorMessage,
  parseErrorBody,
  parseErrorFromStderr,
} from "./agent-runner-service.js";
import { callGatewayRpc } from "./gateway-rpc-client.js";
import { getSessionMeta, readIndex, resolveSessionKey } from "./web-session-service.js";
import { listSubagentsForRequesterSession, readSubagentRegistry } from "./subagent-registry-service.js";

// ── Types ──

export type SseEvent = Record<string, unknown> & { type: string };
export type RunSubscriber = (event: SseEvent | null) => void;

type AccumulatedPart =
  | { type: "reasoning"; text: string }
  | {
      type: "tool-invocation";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: Record<string, unknown>;
      errorText?: string;
    }
  | { type: "text"; text: string };

type AccumulatedMessage = {
  id: string;
  role: "assistant";
  parts: AccumulatedPart[];
};

export type ActiveRun = {
  sessionId: string;
  childProcess: AgentProcessHandle;
  eventBuffer: SseEvent[];
  subscribers: Set<RunSubscriber>;
  accumulated: AccumulatedMessage;
  status: "running" | "waiting-for-subagents" | "completed" | "error";
  startedAt: number;
  exitCode: number | null;
  abortController: AbortController;
  _persistTimer: ReturnType<typeof setTimeout> | null;
  _lastPersistedAt: number;
  lastGlobalSeq: number;
  _subscribeProcess?: AgentProcessHandle | null;
  _subscribeRetryTimer?: ReturnType<typeof setTimeout> | null;
  _subscribeRetryAttempt?: number;
  sessionKey?: string;
  parentSessionId?: string;
  task?: string;
  label?: string;
  isSubscribeOnly?: boolean;
  _lifecycleEnded?: boolean;
  _finalizeTimer?: ReturnType<typeof setTimeout> | null;
  _waitingFinalizeTimer?: ReturnType<typeof setTimeout> | null;
  pinnedAgentId?: string;
  pinnedSessionKey?: string;
};

// ── Constants ──

const PERSIST_INTERVAL_MS = 2_000;
const CLEANUP_GRACE_MS = 30_000;
const SUBSCRIBE_CLEANUP_GRACE_MS = 24 * 60 * 60_000;
const SUBSCRIBE_RETRY_BASE_MS = 300;
const SUBSCRIBE_RETRY_MAX_MS = 5_000;
const SUBSCRIBE_LIFECYCLE_END_GRACE_MS = 750;
const WAITING_FINALIZE_RECONCILE_MS = 5_000;
const MAX_WAITING_DURATION_MS = 10 * 60_000;
const SUBAGENT_REGISTRY_STALENESS_MS = 15 * 60_000;
const SILENT_REPLY_TOKEN = "NO_REPLY";

function isLeakedSilentReplyToken(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (new RegExp(`^${SILENT_REPLY_TOKEN}\\W*$`).test(t)) return true;
  if (SILENT_REPLY_TOKEN.startsWith(t) && t.length >= 2 && t.length < SILENT_REPLY_TOKEN.length) return true;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  if (typeof model !== "string" || !model.trim()) return null;
  const m = model.trim();
  if (typeof provider === "string" && provider.trim()) {
    const p = provider.trim();
    return m.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? m : `${p}/${m}`;
  }
  return m;
}

function extractAssistantTextFromChatPayload(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const state = typeof data.state === "string" ? data.state : "";
  if (state !== "final") return "";
  const message = asRecord(data.message);
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) continue;
    const type = typeof rec.type === "string" ? rec.type : "";
    if ((type === "text" || type === "output_text") && typeof rec.text === "string") chunks.push(rec.text);
  }
  return chunks.join("");
}

function webChatDir(): string { return resolveWebChatDir(); }
function indexFile(): string { return join(webChatDir(), "index.json"); }

// ── Singleton registry ──

const GLOBAL_KEY = "__openclaw_activeRuns" as const;
const activeRuns: Map<string, ActiveRun> =
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveRun> ?? new Map<string, ActiveRun>();
(globalThis as Record<string, unknown>)[GLOBAL_KEY] = activeRuns;

const fileMutationQueues = new Map<string, Promise<void>>();

async function pathExistsAsync(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function safeSessionFilePath(sessionId: string): string {
  const dir = resolvePath(webChatDir());
  const safe = resolvePath(dir, basename(sessionId) + ".jsonl");
  if (!safe.startsWith(dir + "/")) throw new Error("Invalid session id");
  return safe;
}

async function queueFileMutation<T>(filePath: string, mutate: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(mutate);
  const settled = next.then(() => undefined, () => undefined);
  fileMutationQueues.set(filePath, settled);
  try { return await next; } finally {
    if (fileMutationQueues.get(filePath) === settled) fileMutationQueues.delete(filePath);
  }
}

// ── Public API ──

export function getActiveRun(sessionId: string): ActiveRun | undefined {
  return activeRuns.get(sessionId);
}

export function hasActiveRun(sessionId: string): boolean {
  const run = activeRuns.get(sessionId);
  return run !== undefined && (run.status === "running" || run.status === "waiting-for-subagents");
}

export function getRunningSessionIds(): string[] {
  const ids: string[] = [];
  for (const [sessionId, run] of activeRuns) {
    if (run.status === "running" || run.status === "waiting-for-subagents") ids.push(sessionId);
  }
  return ids;
}

function readSharedSubagentRegistryEntries(): Array<Record<string, unknown>> {
  const registryPath = join(resolveOpenClawStateDir(), "subagents", "runs.json");
  if (!existsSync(registryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as { runs?: Record<string, Record<string, unknown>> };
    return Object.values(raw.runs ?? {});
  } catch { return []; }
}

function resolveSubscribeRunDiskStatus(sessionKey: string): "running" | "completed" | "error" | "unknown" {
  for (const entry of readSharedSubagentRegistryEntries()) {
    if (entry.childSessionKey !== sessionKey) continue;
    if (typeof entry.endedAt !== "number") return "running";
    const outcome = asRecord(entry.outcome);
    if (outcome?.status === "error") return "error";
    return "completed";
  }
  return "unknown";
}

function reconcileSubscribeOnlyRunWithDisk(run: ActiveRun): "running" | "completed" | "error" | "unknown" {
  if (!run.isSubscribeOnly || !run.sessionKey || run.status !== "running") {
    if (run.status === "completed") return "completed";
    if (run.status === "error") return "error";
    return "unknown";
  }
  return resolveSubscribeRunDiskStatus(run.sessionKey);
}

function hasRunningSubagentsInMemory(parentWebSessionId: string): boolean {
  for (const [_key, run] of activeRuns) {
    if (run.isSubscribeOnly && run.parentSessionId === parentWebSessionId && run.status === "running") {
      const diskStatus = reconcileSubscribeOnlyRunWithDisk(run);
      if (diskStatus === "completed" || diskStatus === "error") continue;
      return true;
    }
  }
  return false;
}

export async function hasRunningSubagentsForParent(parentWebSessionId: string): Promise<boolean> {
  if (hasRunningSubagentsInMemory(parentWebSessionId)) return true;
  const parentKeyPattern = `:web:${parentWebSessionId}`;
  const now = Date.now();
  for (const entry of readSharedSubagentRegistryEntries()) {
    const requester = typeof entry.requesterSessionKey === "string" ? entry.requesterSessionKey : "";
    if (!requester.endsWith(parentKeyPattern)) continue;
    if (typeof entry.endedAt === "number") continue;
    const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : 0;
    if (createdAt > 0 && now - createdAt > SUBAGENT_REGISTRY_STALENESS_MS) continue;
    return true;
  }
  return false;
}

export function subscribeToRun(
  sessionId: string,
  callback: RunSubscriber,
  options?: { replay?: boolean },
): (() => void) | null {
  const run = activeRuns.get(sessionId);
  if (!run) return null;
  const replay = options?.replay ?? true;

  if (replay) {
    for (const event of run.eventBuffer) callback(event);
  }

  if (run.isSubscribeOnly && run.status === "running") {
    const diskStatus = reconcileSubscribeOnlyRunWithDisk(run);
    if (diskStatus === "completed" || diskStatus === "error") finalizeSubscribeRun(run, diskStatus);
  }

  if (run.status !== "running" && run.status !== "waiting-for-subagents") {
    if (!replay && run.status === "error") {
      for (const event of run.eventBuffer) callback(event);
    }
    callback(null);
    return () => {};
  }

  run.subscribers.add(callback);
  return () => { run.subscribers.delete(callback); };
}

export function reactivateSubscribeRun(sessionKey: string, message?: string): boolean {
  const run = activeRuns.get(sessionKey);
  if (!run?.isSubscribeOnly) return false;
  if (run.status === "running") return true;

  run.status = "running";
  run._lifecycleEnded = false;
  if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
  clearWaitingFinalizeTimer(run);
  resetSubscribeRetryState(run);
  stopSubscribeProcess(run);

  run.accumulated = { id: `assistant-${sessionKey}-${Date.now()}`, role: "assistant", parts: [] };

  const newChild = message
    ? spawnAgentStartForSession(message, sessionKey)
    : spawnAgentSubscribeProcess(sessionKey, run.lastGlobalSeq);
  run._subscribeProcess = newChild;
  run.childProcess = newChild;
  wireSubscribeOnlyProcess(run, newChild, sessionKey);
  return true;
}

export function sendSubagentFollowUp(sessionKey: string, message: string): boolean {
  try {
    void callGatewayRpc("agent", {
      message,
      sessionKey,
      idempotencyKey: `follow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      deliver: false,
      channel: "webchat",
      lane: "subagent",
      timeout: 0,
    }, { timeoutMs: 10_000 }).catch(() => {});
    return true;
  } catch { return false; }
}

export async function persistSubscribeUserMessage(
  sessionKey: string,
  msg: { id?: string; text: string },
): Promise<boolean> {
  const run = activeRuns.get(sessionKey);
  if (!run) return false;
  const msgId = msg.id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const event: SseEvent = { type: "user-message", id: msgId, text: msg.text };
  run.eventBuffer.push(event);
  for (const sub of run.subscribers) {
    try { sub(event); } catch { /* ignore */ }
  }
  try {
    const fp = safeSessionFilePath(sessionKey);
    await ensureDir();
    await queueFileMutation(fp, async () => {
      if (!await pathExistsAsync(fp)) await writeFile(fp, "");
      const content = await readFile(fp, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const alreadySaved = lines.some((l) => { try { return JSON.parse(l).id === msgId; } catch { return false; } });
      if (alreadySaved) return;
      const line = JSON.stringify({
        id: msgId, role: "user", content: msg.text,
        parts: [{ type: "text", text: msg.text }],
        timestamp: new Date().toISOString(),
      });
      await writeFile(fp, [...lines, line].join("\n") + "\n");
    });
  } catch { /* best effort */ }
  schedulePersist(run);
  return true;
}

export function abortRun(sessionId: string): boolean {
  const run = activeRuns.get(sessionId);
  if (!run || (run.status !== "running" && run.status !== "waiting-for-subagents")) return false;

  const wasWaiting = run.status === "waiting-for-subagents";
  run.status = "error";
  clearWaitingFinalizeTimer(run);
  stopSubscribeProcess(run);
  run.abortController.abort();
  if (!wasWaiting) run.childProcess.kill("SIGTERM");

  sendGatewayAbort(sessionId);
  flushPersistence(run).catch(() => {});

  for (const sub of run.subscribers) {
    try { sub(null); } catch { /* ignore */ }
  }
  run.subscribers.clear();

  setTimeout(() => {
    if (activeRuns.get(sessionId) === run) cleanupRun(sessionId);
  }, CLEANUP_GRACE_MS);

  if (!wasWaiting) {
    const killTimer = setTimeout(() => {
      try { run.childProcess.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5_000);
    run.childProcess.once("close", () => clearTimeout(killTimer));
  }
  return true;
}

function sendGatewayAbort(sessionId: string): void {
  try {
    const run = activeRuns.get(sessionId);
    const agentId = run?.pinnedAgentId ?? resolveActiveAgentId();
    const sessionKey = run?.pinnedSessionKey ?? `agent:${agentId}:web:${sessionId}`;
    void callGatewayRpc("chat.abort", { sessionKey }, { timeoutMs: 4_000 }).catch(() => {});
  } catch { /* best effort */ }
}

export function startRun(params: {
  sessionId: string;
  message: string;
  agentSessionId?: string;
  overrideAgentId?: string;
}): ActiveRun {
  const { sessionId, message, agentSessionId, overrideAgentId } = params;
  const existing = activeRuns.get(sessionId);
  if (existing?.status === "running") throw new Error("Active run already exists for this session");
  if (existing) cleanupRun(sessionId);

  const agentId = overrideAgentId ?? resolveActiveAgentId();
  const sessionKey = agentSessionId ? `agent:${agentId}:web:${agentSessionId}` : undefined;
  const abortController = new AbortController();
  const child = spawnAgentProcess(message, agentSessionId, overrideAgentId);

  const run: ActiveRun = {
    sessionId, childProcess: child, eventBuffer: [], subscribers: new Set(),
    accumulated: { id: `assistant-${sessionId}-${Date.now()}`, role: "assistant", parts: [] },
    status: "running", startedAt: Date.now(), exitCode: null, abortController,
    _persistTimer: null, _lastPersistedAt: 0, lastGlobalSeq: 0,
    _subscribeRetryTimer: null, _subscribeRetryAttempt: 0, _waitingFinalizeTimer: null,
    pinnedAgentId: agentId, pinnedSessionKey: sessionKey,
  };

  activeRuns.set(sessionId, run);

  const onAbort = () => child.kill("SIGTERM");
  if (abortController.signal.aborted) {
    child.kill("SIGTERM");
  } else {
    abortController.signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => abortController.signal.removeEventListener("abort", onAbort));
  }
  wireChildProcess(run);
  return run;
}

export function startSubscribeRun(params: {
  sessionKey: string;
  parentSessionId: string;
  task: string;
  label?: string;
}): ActiveRun {
  const { sessionKey, parentSessionId, task, label } = params;
  if (activeRuns.has(sessionKey)) return activeRuns.get(sessionKey)!;

  void callGatewayRpc("sessions.patch", {
    key: sessionKey, thinkingLevel: "high", verboseLevel: "full", reasoningLevel: "on",
  }, { timeoutMs: 4_000 }).catch(() => {});

  const abortController = new AbortController();
  const subscribeChild = spawnAgentSubscribeProcess(sessionKey, 0);

  const run: ActiveRun = {
    sessionId: sessionKey, childProcess: subscribeChild, eventBuffer: [], subscribers: new Set(),
    accumulated: { id: `assistant-${sessionKey}-${Date.now()}`, role: "assistant", parts: [] },
    status: "running", startedAt: Date.now(), exitCode: null, abortController,
    _persistTimer: null, _lastPersistedAt: 0, lastGlobalSeq: 0,
    sessionKey, parentSessionId, task, label, isSubscribeOnly: true,
    _lifecycleEnded: false, _finalizeTimer: null, _subscribeRetryTimer: null, _subscribeRetryAttempt: 0,
    _waitingFinalizeTimer: null,
  };

  activeRuns.set(sessionKey, run);
  wireSubscribeOnlyProcess(run, subscribeChild, sessionKey);
  return run;
}

// ── Transcript backfill ──

type TranscriptToolPart = {
  type: "tool-invocation";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
};

function readLatestTranscriptToolParts(
  sessionKey: string,
  pinnedAgentId?: string,
): { sessionId: string; tools: TranscriptToolPart[] } | null {
  const stateDir = resolveOpenClawStateDir();
  const agentId = pinnedAgentId ?? resolveActiveAgentId();
  const sessionsJsonPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");
  if (!existsSync(sessionsJsonPath)) return null;
  const sessions = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as Record<string, Record<string, unknown>>;
  const sessionData = sessions[sessionKey];
  const sessionId = typeof sessionData?.sessionId === "string" ? sessionData.sessionId : null;
  if (!sessionId) return null;
  const transcriptPath = join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) return null;

  const entries = readFileSync(transcriptPath, "utf-8")
    .split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Array<Record<string, unknown>>;

  const toolResults = new Map<string, Record<string, unknown>>();
  let latestToolCalls: TranscriptToolPart[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    const content = msg.content;
    if (role === "toolResult" && typeof msg.toolCallId === "string") {
      const text = Array.isArray(content)
        ? (content as Array<Record<string, unknown>>).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n")
        : typeof content === "string" ? content : "";
      toolResults.set(msg.toolCallId, { text: text.slice(0, 500) });
      continue;
    }
    if (role !== "assistant" || !Array.isArray(content)) continue;
    const calls: TranscriptToolPart[] = [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        calls.push({ type: "tool-invocation", toolCallId: part.id, toolName: part.name, args: (part.arguments as Record<string, unknown>) ?? {} });
      }
    }
    if (calls.length > 0) latestToolCalls = calls;
  }

  if (latestToolCalls.length === 0) return null;
  const withResults = latestToolCalls.map((tool) => {
    const result = toolResults.get(tool.toolCallId);
    return result ? { ...tool, result } : tool;
  });
  return { sessionId, tools: withResults };
}

// ── wireSubscribeOnlyProcess ──

function wireSubscribeOnlyProcess(run: ActiveRun, child: AgentProcessHandle, sessionKey: string): void {
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++idCounter}`;

  let currentTextId = "";
  let currentReasoningId = "";
  let currentStatusReasoningLabel: string | null = null;
  let textStarted = false;
  let reasoningStarted = false;
  let statusReasoningActive = false;
  let agentErrorReported = false;
  const liveStats = { assistantChunks: 0, toolStartCount: 0 };

  let accTextIdx = -1;
  let accReasoningIdx = -1;
  const accToolMap = new Map<string, number>();

  const accAppendReasoning = (delta: string) => {
    if (accReasoningIdx < 0) { run.accumulated.parts.push({ type: "reasoning", text: delta }); accReasoningIdx = run.accumulated.parts.length - 1; }
    else { (run.accumulated.parts[accReasoningIdx] as { type: "reasoning"; text: string }).text += delta; }
  };

  const accAppendText = (delta: string) => {
    if (accTextIdx < 0) { run.accumulated.parts.push({ type: "text", text: delta }); accTextIdx = run.accumulated.parts.length - 1; }
    else { (run.accumulated.parts[accTextIdx] as { type: "text"; text: string }).text += delta; }
  };

  const emit = (event: SseEvent) => {
    run.eventBuffer.push(event);
    for (const sub of run.subscribers) { try { sub(event); } catch { /* ignore */ } }
    schedulePersist(run);
  };

  const emitError = (message: string) => {
    closeReasoning(); closeText();
    const tid = nextId("text");
    emit({ type: "text-start", id: tid });
    emit({ type: "text-delta", id: tid, delta: `[error] ${message}` });
    emit({ type: "text-end", id: tid });
    accAppendText(`[error] ${message}`);
  };

  const closeReasoning = () => {
    if (reasoningStarted) { emit({ type: "reasoning-end", id: currentReasoningId }); reasoningStarted = false; statusReasoningActive = false; }
    currentStatusReasoningLabel = null; accReasoningIdx = -1;
  };

  const closeText = () => {
    if (textStarted) {
      const lastPart = run.accumulated.parts[accTextIdx];
      if (lastPart?.type === "text" && isLeakedSilentReplyToken(lastPart.text)) run.accumulated.parts.splice(accTextIdx, 1);
      emit({ type: "text-end", id: currentTextId }); textStarted = false;
    }
    accTextIdx = -1;
  };

  const openStatusReasoning = (label: string) => {
    if (statusReasoningActive && currentStatusReasoningLabel === label) return;
    closeReasoning(); closeText();
    currentReasoningId = nextId("status");
    emit({ type: "reasoning-start", id: currentReasoningId });
    emit({ type: "reasoning-delta", id: currentReasoningId, delta: label });
    reasoningStarted = true; statusReasoningActive = true; currentStatusReasoningLabel = label;
  };

  const maybeBackfillLiveToolsFromTranscript = (_reason: "assistant-chunk" | "lifecycle-end") => {
    if (liveStats.toolStartCount > 0) return;
    const bundle = readLatestTranscriptToolParts(sessionKey, run.pinnedAgentId);
    if (!bundle) return;
    for (const tool of bundle.tools) {
      const existingIdx = accToolMap.get(tool.toolCallId);
      if (existingIdx === undefined) {
        closeReasoning(); closeText();
        emit({ type: "tool-input-start", toolCallId: tool.toolCallId, toolName: tool.toolName });
        emit({ type: "tool-input-available", toolCallId: tool.toolCallId, toolName: tool.toolName, input: tool.args ?? {} });
        run.accumulated.parts.push({ type: "tool-invocation", toolCallId: tool.toolCallId, toolName: tool.toolName, args: tool.args ?? {} });
        accToolMap.set(tool.toolCallId, run.accumulated.parts.length - 1);
      }
      if (!tool.result) continue;
      const idx = accToolMap.get(tool.toolCallId);
      if (idx === undefined) continue;
      const part = run.accumulated.parts[idx];
      if (part.type !== "tool-invocation" || part.result) continue;
      part.result = tool.result;
      emit({ type: "tool-output-available", toolCallId: tool.toolCallId, output: tool.result });
    }
  };

  const processEvent = (ev: AgentEvent) => {
    const isLifecycleEndEvent = ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "end";
    if (!isLifecycleEndEvent) {
      if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
      run._lifecycleEnded = false;
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "start") openStatusReasoning("Preparing response...");

    if (ev.event === "agent" && ev.stream === "thinking") {
      const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
      if (delta) {
        if (statusReasoningActive) closeReasoning();
        if (!reasoningStarted) { currentReasoningId = nextId("reasoning"); emit({ type: "reasoning-start", id: currentReasoningId }); reasoningStarted = true; }
        emit({ type: "reasoning-delta", id: currentReasoningId, delta });
        accAppendReasoning(delta);
      }
    }

    if (ev.event === "agent" && ev.stream === "assistant") {
      const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
      const textFallback = !delta && typeof ev.data?.text === "string" ? ev.data.text : undefined;
      const chunk = delta ?? textFallback;
      if (chunk) {
        liveStats.assistantChunks += 1;
        if (liveStats.toolStartCount === 0 && (liveStats.assistantChunks === 1 || liveStats.assistantChunks % 40 === 0)) {
          maybeBackfillLiveToolsFromTranscript("assistant-chunk");
        }
        closeReasoning();
        if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
        emit({ type: "text-delta", id: currentTextId, delta: chunk });
        accAppendText(chunk);
      }
      const mediaUrls = ev.data?.mediaUrls;
      if (Array.isArray(mediaUrls)) {
        for (const url of mediaUrls) {
          if (typeof url === "string" && url.trim()) {
            closeReasoning();
            if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
            const md = `\n![media](${url.trim()})\n`;
            emit({ type: "text-delta", id: currentTextId, delta: md });
            accAppendText(md);
          }
        }
      }
      if (typeof ev.data?.stopReason === "string" && ev.data.stopReason === "error" && !agentErrorReported) {
        agentErrorReported = true;
        const errMsg = typeof ev.data?.errorMessage === "string"
          ? parseErrorBody(ev.data.errorMessage)
          : (parseAgentErrorMessage(ev.data) ?? "Agent stopped with an error");
        emitError(errMsg);
      }
    }

    if (ev.event === "agent" && ev.stream === "tool") {
      const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
      const toolCallId = typeof ev.data?.toolCallId === "string" ? ev.data.toolCallId : "";
      const toolName = typeof ev.data?.name === "string" ? ev.data.name : "";
      if (phase === "start") {
        liveStats.toolStartCount += 1;
        closeReasoning(); closeText();
        const args = ev.data?.args && typeof ev.data.args === "object" ? (ev.data.args as Record<string, unknown>) : {};
        emit({ type: "tool-input-start", toolCallId, toolName });
        emit({ type: "tool-input-available", toolCallId, toolName, input: args });
        run.accumulated.parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        accToolMap.set(toolCallId, run.accumulated.parts.length - 1);
      } else if (phase === "update") {
        const partialResult = extractToolResult(ev.data?.partialResult);
        if (partialResult) emit({ type: "tool-output-partial", toolCallId, output: buildToolOutput(partialResult) });
      } else if (phase === "result") {
        const isError = ev.data?.isError === true;
        const result = extractToolResult(ev.data?.result);
        if (isError) {
          const errorText = result?.text || (result?.details?.error as string | undefined) || "Tool execution failed";
          emit({ type: "tool-output-error", toolCallId, errorText });
          const idx = accToolMap.get(toolCallId);
          if (idx !== undefined) { const part = run.accumulated.parts[idx]; if (part.type === "tool-invocation") part.errorText = errorText; }
        } else {
          const output = buildToolOutput(result);
          emit({ type: "tool-output-available", toolCallId, output });
          const idx = accToolMap.get(toolCallId);
          if (idx !== undefined) { const part = run.accumulated.parts[idx]; if (part.type === "tool-invocation") part.result = output; }
        }
      }
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && (ev.data?.phase === "fallback" || ev.data?.phase === "fallback_cleared")) {
      const data = ev.data;
      const selected = resolveModelLabel(data?.selectedProvider, data?.selectedModel) ?? resolveModelLabel(data?.fromProvider, data?.fromModel);
      const active = resolveModelLabel(data?.activeProvider, data?.activeModel) ?? resolveModelLabel(data?.toProvider, data?.toModel);
      if (selected && active) {
        const isClear = data?.phase === "fallback_cleared";
        const reason = typeof data?.reasonSummary === "string" ? data.reasonSummary : typeof data?.reason === "string" ? data.reason : undefined;
        const label2 = isClear ? `Restored to ${selected}` : `Switched to ${active}${reason ? ` (${reason})` : ""}`;
        openStatusReasoning(label2);
      }
    }

    if (ev.event === "agent" && ev.stream === "compaction") {
      const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
      if (phase === "start") openStatusReasoning("Optimizing session context...");
      else if (phase === "end") {
        if (statusReasoningActive) {
          if (ev.data?.willRetry === true) { const retryDelta = "\nRetrying with compacted context..."; emit({ type: "reasoning-delta", id: currentReasoningId, delta: retryDelta }); accAppendReasoning(retryDelta); }
          else closeReasoning();
        }
      }
    }

    if (ev.event === "chat") {
      const finalText = extractAssistantTextFromChatPayload(ev.data);
      const state = typeof ev.data?.state === "string" ? ev.data.state : "";
      const message = asRecord(ev.data?.message);
      const role = typeof message?.role === "string" ? message.role : "";
      if (finalText) {
        if (liveStats.assistantChunks === 0) {
          closeReasoning();
          if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
          emit({ type: "text-delta", id: currentTextId, delta: finalText }); accAppendText(finalText); closeText();
        }
      }
      if (state === "final" && role === "assistant" && run.status === "running") {
        finalizeSubscribeRun(run); return;
      }
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "end") {
      maybeBackfillLiveToolsFromTranscript("lifecycle-end");
      closeReasoning(); closeText();
      run._lifecycleEnded = true;
      if (run._finalizeTimer) clearTimeout(run._finalizeTimer);
      run._finalizeTimer = setTimeout(() => {
        run._finalizeTimer = null;
        if (run.status === "running") finalizeSubscribeRun(run);
      }, SUBSCRIBE_LIFECYCLE_END_GRACE_MS);
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "error" && !agentErrorReported) {
      agentErrorReported = true;
      emitError(parseAgentErrorMessage(ev.data) ?? "Agent encountered an error");
      finalizeSubscribeRun(run, "error");
    }

    if (ev.event === "error" && !agentErrorReported) {
      agentErrorReported = true;
      emitError(parseAgentErrorMessage(ev.data ?? (ev as unknown as Record<string, unknown>)) ?? "An unknown error occurred");
    }
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let ev: AgentEvent;
    try { ev = JSON.parse(line) as AgentEvent; } catch { return; }
    if (ev.sessionKey && ev.sessionKey !== sessionKey) return;
    const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number" ? (ev as Record<string, unknown>).globalSeq as number : undefined;
    if (gSeq !== undefined) { if (gSeq <= run.lastGlobalSeq) return; run.lastGlobalSeq = gSeq; }
    if ((run._subscribeRetryAttempt ?? 0) > 0) resetSubscribeRetryState(run);
    processEvent(ev);
  });

  child.on("close", () => {
    if (run._subscribeProcess !== child) return;
    run._subscribeProcess = null;
    const diskStatus = reconcileSubscribeOnlyRunWithDisk(run);
    if (diskStatus === "completed" || diskStatus === "error") { finalizeSubscribeRun(run, diskStatus); return; }
    if (run.status !== "running") return;
    if (run._lifecycleEnded) {
      if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
      finalizeSubscribeRun(run); return;
    }
    scheduleSubscribeRestart(run, () => {
      if (run.status === "running" && !run._subscribeProcess) {
        const newChild = spawnAgentSubscribeProcess(sessionKey, run.lastGlobalSeq);
        run._subscribeProcess = newChild; run.childProcess = newChild;
        wireSubscribeOnlyProcess(run, newChild, sessionKey);
      }
    });
  });

  child.on("error", (err) => {
    console.error("[active-runs] Subscribe child error:", err);
    if (run.status !== "running") return;
    const message = err instanceof Error ? err.message : String(err);
    emitError(`Failed to connect to agent: ${message}`);
    finalizeSubscribeRun(run, "error");
  });
  child.stderr?.on("data", (chunk: Buffer) => { console.error("[active-runs subscribe stderr]", chunk.toString()); });
  run._subscribeProcess = child;
}

function finalizeSubscribeRun(run: ActiveRun, status: "completed" | "error" = "completed"): void {
  if (run.status !== "running") return;
  if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
  clearWaitingFinalizeTimer(run);
  resetSubscribeRetryState(run);
  run.status = status;
  flushPersistence(run).catch(() => {});
  for (const sub of run.subscribers) { try { sub(null); } catch { /* ignore */ } }
  run.subscribers.clear();
  stopSubscribeProcess(run);

  const hasToolParts = run.accumulated.parts.some((p) => p.type === "tool-invocation");
  if (run.isSubscribeOnly && run.sessionKey && !hasToolParts) {
    const sk = run.sessionKey;
    const aid = run.pinnedAgentId;
    setTimeout(() => { deferredTranscriptEnrich(sk, aid); }, 2_000);
  }

  const grace = run.isSubscribeOnly ? SUBSCRIBE_CLEANUP_GRACE_MS : CLEANUP_GRACE_MS;
  setTimeout(() => {
    if (activeRuns.get(run.sessionId) === run) cleanupRun(run.sessionId);
  }, grace);
}

function deferredTranscriptEnrich(sessionKey: string, pinnedAgentId?: string): void {
  try {
    const stateDir = resolveOpenClawStateDir();
    const agentId = pinnedAgentId ?? resolveActiveAgentId();
    const sessionsJsonPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");
    if (!existsSync(sessionsJsonPath)) return;
    const sessions = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as Record<string, Record<string, unknown>>;
    const sessionData = sessions[sessionKey];
    const sessionId = typeof sessionData?.sessionId === "string" ? sessionData.sessionId : null;
    if (!sessionId) return;
    const transcriptPath = join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    if (!existsSync(transcriptPath)) return;

    const entries = readFileSync(transcriptPath, "utf-8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;

    const toolResults = new Map<string, Record<string, unknown>>();
    let pendingTools: Array<Record<string, unknown>> = [];
    const textToTools = new Map<string, Array<Record<string, unknown>>>();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const content = msg.content;
      if (msg.role === "user") pendingTools = [];
      if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
        const text = Array.isArray(content) ? (content as Array<Record<string, unknown>>).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n") : typeof content === "string" ? content : "";
        toolResults.set(msg.toolCallId, { text: text.slice(0, 500) });
      }
      if (msg.role !== "assistant" || !Array.isArray(content)) continue;
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          pendingTools.push({ type: "tool-invocation", toolCallId: part.id, toolName: part.name, args: (part.arguments as Record<string, unknown>) ?? {} });
        }
      }
      const textParts = (content as Array<Record<string, unknown>>).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => (c.text as string).trim()).filter(Boolean);
      if (textParts.length > 0 && pendingTools.length > 0) {
        const key = textParts.join("\n").slice(0, 200);
        if (key.length >= 10) {
          const toolsWithResults = pendingTools.map((tp) => { const result = toolResults.get(tp.toolCallId as string); return result ? { ...tp, result } : tp; });
          textToTools.set(key, toolsWithResults);
          pendingTools = [];
        }
      }
    }

    if (textToTools.size === 0) return;
    const fp = safeSessionFilePath(sessionKey);
    if (!existsSync(fp)) return;
    const lines = readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim());
    const messages = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;

    let changed = false;
    const enriched = messages.map((m) => {
      if (m.role !== "assistant") return m;
      const parts = (m.parts as Array<Record<string, unknown>>) ?? [{ type: "text", text: m.content }];
      if (parts.some((p) => p.type === "tool-invocation")) return m;
      const msgText = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => (p.text as string).trim()).filter(Boolean).join("\n").slice(0, 200);
      if (msgText.length < 10) return m;
      const tools = textToTools.get(msgText);
      if (!tools || tools.length === 0) return m;
      const textP = parts.filter((p) => p.type === "text");
      const otherP = parts.filter((p) => p.type !== "text");
      changed = true;
      return { ...m, parts: [...otherP, ...tools, ...textP] };
    });

    if (changed) writeFileSync(fp, enriched.map((m) => JSON.stringify(m)).join("\n") + "\n");
  } catch { /* best effort */ }
}

export function enrichSubagentSessionFromTranscript(sessionKey: string): void {
  if (!sessionKey.includes(":subagent:")) return;
  deferredTranscriptEnrich(sessionKey);
}

// ── Persistence helpers ──

export async function persistUserMessage(
  sessionId: string,
  msg: { id: string; content: string; parts?: unknown[]; html?: string },
): Promise<void> {
  await ensureDir();
  const filePath = safeSessionFilePath(sessionId);
  const line = JSON.stringify({
    id: msg.id, role: "user", content: msg.content,
    ...(msg.parts ? { parts: msg.parts } : {}),
    ...(msg.html ? { html: msg.html } : {}),
    timestamp: new Date().toISOString(),
  });

  let alreadySaved = false;
  await queueFileMutation(filePath, async () => {
    if (!await pathExistsAsync(filePath)) await writeFile(filePath, "");
    const existing = await readFile(filePath, "utf-8");
    const lines = existing.split("\n").filter((l) => l.trim());
    alreadySaved = lines.some((l) => { try { return JSON.parse(l).id === msg.id; } catch { return false; } });
    if (!alreadySaved) await writeFile(filePath, [...lines, line].join("\n") + "\n");
  });

  if (!alreadySaved) await updateIndex(sessionId, { incrementCount: 1 });
}

// ── Internals ──

async function ensureDir() {
  await mkdir(webChatDir(), { recursive: true });
}

async function updateIndex(sessionId: string, opts: { incrementCount?: number; title?: string }) {
  try {
    const idxPath = indexFile();
    await ensureDir();
    await queueFileMutation(idxPath, async () => {
      let index: Array<Record<string, unknown>>;
      if (!await pathExistsAsync(idxPath)) {
        index = [{ id: sessionId, title: opts.title || "New Chat", createdAt: Date.now(), updatedAt: Date.now(), messageCount: opts.incrementCount || 0 }];
        await writeFile(idxPath, JSON.stringify(index, null, 2));
        return;
      }
      index = JSON.parse(await readFile(idxPath, "utf-8")) as Array<Record<string, unknown>>;
      let session = index.find((s) => s.id === sessionId);
      if (!session) {
        session = { id: sessionId, title: opts.title || "New Chat", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
        index.unshift(session);
      }
      session.updatedAt = Date.now();
      if (opts.incrementCount) session.messageCount = ((session.messageCount as number) || 0) + opts.incrementCount;
      if (opts.title) session.title = opts.title;
      await writeFile(idxPath, JSON.stringify(index, null, 2));
    });
  } catch { /* best-effort */ }
}

// ── SSE event generation from child-process JSON lines ──

function wireChildProcess(run: ActiveRun): void {
  const child = run.childProcess;
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++idCounter}`;

  let currentTextId = "";
  let currentReasoningId = "";
  let currentStatusReasoningLabel: string | null = null;
  let textStarted = false;
  let reasoningStarted = false;
  let everSentText = false;
  let statusReasoningActive = false;
  let waitingStatusAnnounced = false;
  let agentErrorReported = false;
  let parentAssistantChunksCurrentTurn = 0;
  const stderrChunks: string[] = [];

  let accTextIdx = -1;
  let accReasoningIdx = -1;
  const accToolMap = new Map<string, number>();

  const accAppendReasoning = (delta: string) => {
    if (accReasoningIdx < 0) { run.accumulated.parts.push({ type: "reasoning", text: delta }); accReasoningIdx = run.accumulated.parts.length - 1; }
    else { (run.accumulated.parts[accReasoningIdx] as { type: "reasoning"; text: string }).text += delta; }
  };

  const accAppendText = (delta: string) => {
    if (accTextIdx < 0) { run.accumulated.parts.push({ type: "text", text: delta }); accTextIdx = run.accumulated.parts.length - 1; }
    else { (run.accumulated.parts[accTextIdx] as { type: "text"; text: string }).text += delta; }
  };

  const emit = (event: SseEvent) => {
    run.eventBuffer.push(event);
    for (const sub of run.subscribers) { try { sub(event); } catch { /* ignore */ } }
    schedulePersist(run);
  };

  const closeReasoning = () => {
    if (reasoningStarted) { emit({ type: "reasoning-end", id: currentReasoningId }); reasoningStarted = false; statusReasoningActive = false; }
    currentStatusReasoningLabel = null; accReasoningIdx = -1;
  };

  const closeText = () => {
    if (textStarted) {
      if (accTextIdx >= 0) {
        const part = run.accumulated.parts[accTextIdx] as { type: "text"; text: string };
        if (isLeakedSilentReplyToken(part.text)) {
          run.accumulated.parts.splice(accTextIdx, 1);
          for (const [k, v] of accToolMap) { if (v > accTextIdx) accToolMap.set(k, v - 1); }
        }
      }
      emit({ type: "text-end", id: currentTextId }); textStarted = false;
    }
    accTextIdx = -1;
  };

  const openStatusReasoning = (label: string) => {
    if (statusReasoningActive && currentStatusReasoningLabel === label) return;
    closeReasoning(); closeText();
    currentReasoningId = nextId("status");
    emit({ type: "reasoning-start", id: currentReasoningId });
    emit({ type: "reasoning-delta", id: currentReasoningId, delta: label });
    reasoningStarted = true; statusReasoningActive = true; currentStatusReasoningLabel = label;
    accAppendReasoning(label);
  };

  const emitError = (message: string) => {
    closeReasoning(); closeText();
    const tid = nextId("text");
    emit({ type: "text-start", id: tid });
    emit({ type: "text-delta", id: tid, delta: `[error] ${message}` });
    emit({ type: "text-end", id: tid });
    accAppendText(`[error] ${message}`);
    accTextIdx = -1; everSentText = true;
  };

  const emitAssistantFinalText = (text: string) => {
    if (!text) return;
    closeReasoning();
    if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
    everSentText = true;
    emit({ type: "text-delta", id: currentTextId, delta: text });
    accAppendText(text); closeText();
  };

  const rl = createInterface({ input: child.stdout! });
  const pinnedAgent = run.pinnedAgentId ?? resolveActiveAgentId();
  const parentSessionKey = run.pinnedSessionKey ?? `agent:${pinnedAgent}:web:${run.sessionId}`;
  rl.on("error", () => {});

  const processParentEvent = (ev: AgentEvent) => {
    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "start") {
      parentAssistantChunksCurrentTurn = 0; openStatusReasoning("Preparing response...");
    }

    if (ev.event === "agent" && ev.stream === "thinking") {
      const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
      if (delta) {
        if (statusReasoningActive) closeReasoning();
        if (!reasoningStarted) { currentReasoningId = nextId("reasoning"); emit({ type: "reasoning-start", id: currentReasoningId }); reasoningStarted = true; }
        emit({ type: "reasoning-delta", id: currentReasoningId, delta }); accAppendReasoning(delta);
      }
    }

    if (ev.event === "agent" && ev.stream === "assistant") {
      const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
      const textFallback = !delta && typeof ev.data?.text === "string" ? ev.data.text : undefined;
      const chunk = delta ?? textFallback;
      if (chunk) {
        parentAssistantChunksCurrentTurn += 1;
        closeReasoning();
        if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
        everSentText = true;
        emit({ type: "text-delta", id: currentTextId, delta: chunk }); accAppendText(chunk);
      }
      const mediaUrls = ev.data?.mediaUrls;
      if (Array.isArray(mediaUrls)) {
        for (const url of mediaUrls) {
          if (typeof url === "string" && url.trim()) {
            closeReasoning();
            if (!textStarted) { currentTextId = nextId("text"); emit({ type: "text-start", id: currentTextId }); textStarted = true; }
            everSentText = true;
            const md = `\n![media](${url.trim()})\n`;
            emit({ type: "text-delta", id: currentTextId, delta: md }); accAppendText(md);
          }
        }
      }
      if (typeof ev.data?.stopReason === "string" && ev.data.stopReason === "error" && !agentErrorReported) {
        agentErrorReported = true;
        const errMsg = typeof ev.data?.errorMessage === "string" ? parseErrorBody(ev.data.errorMessage) : (parseAgentErrorMessage(ev.data) ?? "Agent stopped with an error");
        emitError(errMsg);
      }
    }

    if (ev.event === "agent" && ev.stream === "tool") {
      const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
      const toolCallId = typeof ev.data?.toolCallId === "string" ? ev.data.toolCallId : "";
      const toolName = typeof ev.data?.name === "string" ? ev.data.name : "";
      if (phase === "start") {
        closeReasoning(); closeText();
        const args = ev.data?.args && typeof ev.data.args === "object" ? (ev.data.args as Record<string, unknown>) : {};
        emit({ type: "tool-input-start", toolCallId, toolName }); emit({ type: "tool-input-available", toolCallId, toolName, input: args });
        run.accumulated.parts.push({ type: "tool-invocation", toolCallId, toolName, args }); accToolMap.set(toolCallId, run.accumulated.parts.length - 1);
      } else if (phase === "update") {
        const partialResult = extractToolResult(ev.data?.partialResult);
        if (partialResult) emit({ type: "tool-output-partial", toolCallId, output: buildToolOutput(partialResult) });
      } else if (phase === "result") {
        const isError = ev.data?.isError === true;
        const result = extractToolResult(ev.data?.result);
        if (isError) {
          const errorText = result?.text || (result?.details?.error as string | undefined) || "Tool execution failed";
          emit({ type: "tool-output-error", toolCallId, errorText });
          const idx = accToolMap.get(toolCallId);
          if (idx !== undefined) { const part = run.accumulated.parts[idx]; if (part.type === "tool-invocation") part.errorText = errorText; }
        } else {
          const output = buildToolOutput(result);
          emit({ type: "tool-output-available", toolCallId, output });
          const idx = accToolMap.get(toolCallId);
          if (idx !== undefined) { const part = run.accumulated.parts[idx]; if (part.type === "tool-invocation") part.result = output; }
        }
        if (toolName === "sessions_spawn" && !isError) {
          const childSessionKey = result?.details?.childSessionKey as string | undefined;
          if (childSessionKey) {
            const spawnArgs = accToolMap.has(toolCallId) ? (run.accumulated.parts[accToolMap.get(toolCallId)!] as { args?: Record<string, unknown> })?.args : undefined;
            startSubscribeRun({ sessionKey: childSessionKey, parentSessionId: run.sessionId, task: (spawnArgs?.task as string | undefined) ?? "Subagent task", label: spawnArgs?.label as string | undefined });
          }
        }
      }
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && (ev.data?.phase === "fallback" || ev.data?.phase === "fallback_cleared")) {
      const data = ev.data;
      const selected = resolveModelLabel(data?.selectedProvider, data?.selectedModel) ?? resolveModelLabel(data?.fromProvider, data?.fromModel);
      const active = resolveModelLabel(data?.activeProvider, data?.activeModel) ?? resolveModelLabel(data?.toProvider, data?.toModel);
      if (selected && active) {
        const isClear = data?.phase === "fallback_cleared";
        const reason = typeof data?.reasonSummary === "string" ? data.reasonSummary : typeof data?.reason === "string" ? data.reason : undefined;
        const l = isClear ? `Restored to ${selected}` : `Switched to ${active}${reason ? ` (${reason})` : ""}`;
        openStatusReasoning(l);
      }
    }

    if (ev.event === "chat") {
      const text = extractAssistantTextFromChatPayload(ev.data);
      if (text) { if (parentAssistantChunksCurrentTurn === 0) emitAssistantFinalText(text); }
    }

    if (ev.event === "agent" && ev.stream === "compaction") {
      const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
      if (phase === "start") openStatusReasoning("Optimizing session context...");
      else if (phase === "end") {
        if (statusReasoningActive) {
          if (ev.data?.willRetry === true) { const d = "\nRetrying with compacted context..."; emit({ type: "reasoning-delta", id: currentReasoningId, delta: d }); accAppendReasoning(d); }
          else closeReasoning();
        }
      }
    }

    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "end") { closeReasoning(); closeText(); }

    if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "error" && !agentErrorReported) {
      agentErrorReported = true; emitError(parseAgentErrorMessage(ev.data) ?? "Agent encountered an error");
    }

    if (ev.event === "error" && !agentErrorReported) {
      agentErrorReported = true; emitError(parseAgentErrorMessage(ev.data ?? (ev as unknown as Record<string, unknown>)) ?? "An unknown error occurred");
    }
  };

  const processParentSubscribeEvent = (ev: AgentEvent) => {
    const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number" ? (ev as Record<string, unknown>).globalSeq as number : undefined;
    if (gSeq !== undefined) { if (gSeq <= run.lastGlobalSeq) return; run.lastGlobalSeq = gSeq; }

    const showWaitingStatus = () => {
      if (!waitingStatusAnnounced) { openStatusReasoning("Waiting for subagent results..."); waitingStatusAnnounced = true; }
      flushPersistence(run).catch(() => {});
    };

    const scheduleWaitingCompletionCheck = () => {
      clearWaitingFinalizeTimer(run);
      run._waitingFinalizeTimer = setTimeout(async () => {
        run._waitingFinalizeTimer = null;
        if (run.status !== "waiting-for-subagents") return;
        if (await hasRunningSubagentsForParent(run.sessionId)) { showWaitingStatus(); return; }
        finalizeWaitingRun(run);
      }, WAITING_FINALIZE_RECONCILE_MS);
    };

    const reconcileWaitingState = () => {
      if (run.status !== "waiting-for-subagents" && run.status !== "running") return;
      if (hasRunningSubagentsInMemory(run.sessionId)) { clearWaitingFinalizeTimer(run); showWaitingStatus(); return; }
      scheduleWaitingCompletionCheck();
    };

    clearWaitingFinalizeTimer(run);
    processParentEvent(ev);
    if (ev.stream === "lifecycle" && ev.data?.phase === "end") reconcileWaitingState();
    if (ev.event === "chat") {
      const payload = ev.data;
      const state = typeof payload?.state === "string" ? payload.state : "";
      const message = asRecord(payload?.message);
      const role = typeof message?.role === "string" ? message.role : "";
      if (state === "final" && role === "assistant") reconcileWaitingState();
    }
  };

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let ev: AgentEvent;
    try { ev = JSON.parse(line) as AgentEvent; } catch { return; }
    if (ev.sessionKey && ev.sessionKey !== parentSessionKey) return;
    const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number" ? (ev as Record<string, unknown>).globalSeq as number : undefined;
    if (gSeq !== undefined && gSeq > run.lastGlobalSeq) run.lastGlobalSeq = gSeq;
    processParentEvent(ev);
  });

  child.on("close", (code) => {
    if (run.status !== "running") { run.exitCode = code; return; }
    if (!agentErrorReported && stderrChunks.length > 0) {
      const stderr = stderrChunks.join("").trim();
      const msg = parseErrorFromStderr(stderr);
      if (msg) { agentErrorReported = true; emitError(msg); }
    }
    closeReasoning();
    const exitedClean = code === 0 || code === null;
    if (!everSentText && !exitedClean) {
      const tid = nextId("text");
      emit({ type: "text-start", id: tid }); const errMsg = `[error] Agent exited with code ${code}. Check server logs for details.`;
      emit({ type: "text-delta", id: tid, delta: errMsg }); emit({ type: "text-end", id: tid }); accAppendText(errMsg);
    } else if (!everSentText && exitedClean) {
      emitError("No response from agent.");
    } else { closeText(); }

    run.exitCode = code;
    const hasRunningSubagents = hasRunningSubagentsInMemory(run.sessionId);
    if (exitedClean && hasRunningSubagents) {
      run.status = "waiting-for-subagents";
      if (!waitingStatusAnnounced) { openStatusReasoning("Waiting for subagent results..."); waitingStatusAnnounced = true; }
      flushPersistence(run).catch(() => {});
      startParentSubscribeStream(run, parentSessionKey, processParentSubscribeEvent);
      setTimeout(() => { if (run.status === "waiting-for-subagents") finalizeWaitingRun(run); }, MAX_WAITING_DURATION_MS);
      return;
    }

    run.status = exitedClean ? "completed" : "error";
    flushPersistence(run).catch(() => {});
    for (const sub of run.subscribers) { try { sub(null); } catch { /* ignore */ } }
    run.subscribers.clear();
    setTimeout(() => { if (activeRuns.get(run.sessionId) === run) cleanupRun(run.sessionId); }, CLEANUP_GRACE_MS);
  });

  child.on("error", (err) => {
    if (run.status !== "running") return;
    console.error("[active-runs] Child process error:", err);
    const message = err instanceof Error ? err.message : String(err);
    emitError(`Failed to start agent: ${message}`);
    run.status = "error";
    flushPersistence(run).catch(() => {});
    for (const sub of run.subscribers) { try { sub(null); } catch { /* ignore */ } }
    run.subscribers.clear();
    setTimeout(() => { if (activeRuns.get(run.sessionId) === run) cleanupRun(run.sessionId); }, CLEANUP_GRACE_MS);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    console.error("[active-runs stderr]", text);
  });
}

function startParentSubscribeStream(run: ActiveRun, parentSessionKey: string, onEvent: (ev: AgentEvent) => void): void {
  stopSubscribeProcess(run);
  const child = spawnAgentSubscribeProcess(parentSessionKey, run.lastGlobalSeq);
  run._subscribeProcess = child;
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let ev: AgentEvent;
    try { ev = JSON.parse(line) as AgentEvent; } catch { return; }
    if (ev.sessionKey && ev.sessionKey !== parentSessionKey) return;
    if ((run._subscribeRetryAttempt ?? 0) > 0) resetSubscribeRetryState(run);
    onEvent(ev);
  });
  child.on("close", () => {
    if (run._subscribeProcess !== child) return;
    run._subscribeProcess = null;
    if (run.status !== "waiting-for-subagents") return;
    scheduleSubscribeRestart(run, () => {
      if (run.status === "waiting-for-subagents" && !run._subscribeProcess) startParentSubscribeStream(run, parentSessionKey, onEvent);
    });
  });
  child.on("error", (err) => { console.error("[active-runs] Parent subscribe child error:", err); });
  child.stderr?.on("data", (chunk: Buffer) => { console.error("[active-runs subscribe stderr]", chunk.toString()); });
}

function stopSubscribeProcess(run: ActiveRun): void {
  clearSubscribeRetryTimer(run); clearWaitingFinalizeTimer(run);
  if (!run._subscribeProcess) return;
  try { run._subscribeProcess.kill("SIGTERM"); } catch { /* ignore */ }
  run._subscribeProcess = null;
}

function finalizeWaitingRun(run: ActiveRun): void {
  if (run.status !== "waiting-for-subagents") return;
  run.status = "completed"; clearWaitingFinalizeTimer(run); resetSubscribeRetryState(run); stopSubscribeProcess(run);
  flushPersistence(run).catch(() => {});
  for (const sub of run.subscribers) { try { sub(null); } catch { /* ignore */ } }
  run.subscribers.clear();
  setTimeout(() => { if (activeRuns.get(run.sessionId) === run) cleanupRun(run.sessionId); }, CLEANUP_GRACE_MS);
}

function clearWaitingFinalizeTimer(run: ActiveRun): void {
  if (!run._waitingFinalizeTimer) return;
  clearTimeout(run._waitingFinalizeTimer); run._waitingFinalizeTimer = null;
}

function clearSubscribeRetryTimer(run: ActiveRun): void {
  if (!run._subscribeRetryTimer) return;
  clearTimeout(run._subscribeRetryTimer); run._subscribeRetryTimer = null;
}

function resetSubscribeRetryState(run: ActiveRun): void {
  run._subscribeRetryAttempt = 0; clearSubscribeRetryTimer(run);
}

function scheduleSubscribeRestart(run: ActiveRun, restart: () => void): void {
  if (run._subscribeRetryTimer) return;
  const attempt = run._subscribeRetryAttempt ?? 0;
  const delay = Math.min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_BASE_MS * 2 ** attempt);
  run._subscribeRetryAttempt = attempt + 1;
  run._subscribeRetryTimer = setTimeout(() => { run._subscribeRetryTimer = null; restart(); }, delay);
}

// ── Debounced persistence ──

function schedulePersist(run: ActiveRun) {
  if (run._persistTimer) return;
  const elapsed = Date.now() - run._lastPersistedAt;
  const delay = Math.max(0, PERSIST_INTERVAL_MS - elapsed);
  run._persistTimer = setTimeout(() => { run._persistTimer = null; flushPersistence(run).catch(() => {}); }, delay);
}

async function flushPersistence(run: ActiveRun) {
  if (run._persistTimer) { clearTimeout(run._persistTimer); run._persistTimer = null; }
  run._lastPersistedAt = Date.now();
  const parts = run.accumulated.parts;
  if (parts.length === 0) return;
  const cleanParts = parts.filter((p) => p.type !== "text" || !isLeakedSilentReplyToken((p as { text: string }).text));
  const text = cleanParts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
  const isStillStreaming = run.status === "running" || run.status === "waiting-for-subagents";
  const message: Record<string, unknown> = { id: run.accumulated.id, role: "assistant", content: text, parts: cleanParts, timestamp: new Date().toISOString() };
  if (isStillStreaming) message._streaming = true;
  try { await upsertMessage(run.sessionId, message); } catch (err) { console.error("[active-runs] Persistence error:", err); }
}

async function upsertMessage(sessionId: string, message: Record<string, unknown>) {
  await ensureDir();
  const fp = safeSessionFilePath(sessionId);
  const msgId = message.id as string;
  let found = false;
  await queueFileMutation(fp, async () => {
    if (!await pathExistsAsync(fp)) await writeFile(fp, "");
    const content = await readFile(fp, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const updated = lines.map((line) => {
      try { const parsed = JSON.parse(line); if (parsed.id === msgId) { found = true; return JSON.stringify(message); } } catch { /* keep as-is */ }
      return line;
    });
    if (!found) updated.push(JSON.stringify(message));
    await writeFile(fp, updated.join("\n") + "\n");
  });
  if (!sessionId.includes(":subagent:")) {
    if (!found) await updateIndex(sessionId, { incrementCount: 1 });
    else await updateIndex(sessionId, {});
  }
}

function cleanupRun(sessionId: string) {
  const run = activeRuns.get(sessionId);
  if (!run) return;
  if (run._persistTimer) clearTimeout(run._persistTimer);
  clearWaitingFinalizeTimer(run);
  stopSubscribeProcess(run);
  activeRuns.delete(sessionId);
}

// ── Re-exports for chat routes ──

export { resolveAgentWorkspacePrefix } from "./workspace-service.js";
export { getSessionMeta, readIndex, resolveSessionKey } from "./web-session-service.js";
export { listSubagentsForRequesterSession, readSubagentRegistry } from "./subagent-registry-service.js";
