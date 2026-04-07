import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { resolveOpenClawStateDir } from "./workspace-service.js";

type CronStoreFile = {
  version: 1;
  jobs: Array<Record<string, unknown>>;
};

type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool-call"; toolName: string; toolCallId: string; args?: unknown; output?: string };

type ParsedMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  timestamp: string;
};

function cronDir(): string {
  return join(resolveOpenClawStateDir(), "cron");
}

function jobsFilePath(): string {
  return join(cronDir(), "jobs.json");
}

function agentsDir(): string {
  return join(resolveOpenClawStateDir(), "agents");
}

function readJobsFile(): Array<Record<string, unknown>> {
  const path = jobsFilePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CronStoreFile;
    if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
    return [];
  } catch {
    return [];
  }
}

function writeJobsFile(jobs: Array<Record<string, unknown>>): void {
  const dir = cronDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const store: CronStoreFile = { version: 1, jobs };
  writeFileSync(jobsFilePath(), JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function computeNextWakeAtMs(jobs: Array<Record<string, unknown>>): number | null {
  let min: number | null = null;
  for (const job of jobs) {
    if (job.enabled !== true) continue;
    const state = job.state as Record<string, unknown> | undefined;
    if (!state) continue;
    const next = state.nextRunAtMs;
    if (typeof next === "number" && Number.isFinite(next)) {
      if (min === null || next < min) min = next;
    }
  }
  return min;
}

function readHeartbeatInfo(): { intervalMs: number; nextDueEstimateMs: number | null } {
  const defaults = { intervalMs: 30 * 60_000, nextDueEstimateMs: null as number | null };
  try {
    const dir = agentsDir();
    if (!existsSync(dir)) return defaults;

    const agentDirs = readdirSync(dir, { withFileTypes: true });
    let latestHeartbeat: number | null = null;

    for (const d of agentDirs) {
      if (!d.isDirectory()) continue;
      const storePath = join(dir, d.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) continue;
      try {
        const store = JSON.parse(readFileSync(storePath, "utf-8")) as Record<string, { updatedAt?: number }>;
        for (const [key, entry] of Object.entries(store)) {
          if (key.startsWith("agent:") && !key.includes(":cron:") && entry.updatedAt) {
            if (latestHeartbeat === null || entry.updatedAt > latestHeartbeat) {
              latestHeartbeat = entry.updatedAt;
            }
          }
        }
      } catch {}
    }

    if (latestHeartbeat) {
      defaults.nextDueEstimateMs = latestHeartbeat + defaults.intervalMs;
    }
  } catch {}
  return defaults;
}

// ── Jobs CRUD ──

export function listCronJobs() {
  const jobs = readJobsFile();
  const heartbeat = readHeartbeatInfo();
  const nextWakeAtMs = computeNextWakeAtMs(jobs);
  return {
    jobs,
    heartbeat,
    cronStatus: { enabled: jobs.length > 0, nextWakeAtMs },
  };
}

export function createCronJob(body: Record<string, unknown>) {
  const now = Date.now();
  const job: Record<string, unknown> = {
    id: randomUUID(),
    name: body.name ?? "Untitled Job",
    description: body.description ?? "",
    enabled: body.enabled ?? true,
    deleteAfterRun: body.deleteAfterRun ?? false,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: body.schedule ?? { kind: "every", everyMs: 3600000 },
    sessionTarget: body.sessionTarget ?? "isolated",
    wakeMode: body.wakeMode ?? "next-heartbeat",
    payload: body.payload ?? { kind: "agentTurn", message: "" },
    delivery: body.delivery,
    state: {},
  };
  const jobs = readJobsFile();
  jobs.push(job);
  writeJobsFile(jobs);
  return { data: job, status: 201 as const };
}

export function updateCronJob(body: Record<string, unknown>) {
  const id = body.id;
  if (typeof id !== "string") {
    return { error: "Missing job id", status: 400 as const };
  }
  const jobs = readJobsFile();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return { error: "Job not found", status: 404 as const };
  }
  const existing = jobs[idx];
  const updated: Record<string, unknown> = { ...existing, ...body, updatedAtMs: Date.now() };
  updated.id = existing.id;
  updated.createdAtMs = existing.createdAtMs;
  jobs[idx] = updated;
  writeJobsFile(jobs);
  return { data: updated, status: 200 as const };
}

export function deleteCronJob(body: Record<string, unknown>) {
  const id = body.id;
  if (typeof id !== "string") {
    return { error: "Missing job id", status: 400 as const };
  }
  const jobs = readJobsFile();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return { error: "Job not found", status: 404 as const };
  }
  jobs.splice(idx, 1);
  writeJobsFile(jobs);
  return { data: { ok: true }, status: 200 as const };
}

// ── Run history ──

function readRunLog(filePath: string, limit: number): CronRunLogEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) return [];
    const lines = raw.split("\n");
    const parsed: CronRunLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as Partial<CronRunLogEntry>;
        if (!obj || typeof obj !== "object") continue;
        if (obj.action !== "finished") continue;
        if (typeof obj.jobId !== "string" || !obj.jobId.trim()) continue;
        if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) continue;
        const entry: CronRunLogEntry = {
          ts: obj.ts,
          jobId: obj.jobId,
          action: "finished",
          status: obj.status,
          error: obj.error,
          summary: obj.summary,
          runAtMs: obj.runAtMs,
          durationMs: obj.durationMs,
          nextRunAtMs: obj.nextRunAtMs,
        };
        if (typeof obj.sessionId === "string" && obj.sessionId.trim()) entry.sessionId = obj.sessionId;
        if (typeof obj.sessionKey === "string" && obj.sessionKey.trim()) entry.sessionKey = obj.sessionKey;
        parsed.push(entry);
      } catch {}
    }
    return parsed.toReversed();
  } catch {
    return [];
  }
}

export function getCronJobRuns(jobId: string, limit: number) {
  if (!jobId) return { error: "Job ID required", status: 400 as const };
  const logPath = join(cronDir(), "runs", `${jobId}.jsonl`);
  const entries = readRunLog(logPath, Math.max(1, Math.min(500, limit)));
  return { data: { entries }, status: 200 as const };
}

// ── Run transcript ──

function findSessionFile(sessionId: string): string | null {
  const dir = agentsDir();
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(dir, entry.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(filePath)) return filePath;
    }
  } catch {}
  return null;
}

function parseSessionTranscript(content: string): ParsedMessage[] {
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const messages: ParsedMessage[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || !entry.message) continue;

      const msg = entry.message;
      const role = msg.role as string;

      if (role === "toolResult") {
        const toolCallId = msg.toolCallId ?? "";
        const rawContent = msg.content;
        const outputText = typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text ?? "").join("\n")
            : JSON.stringify(rawContent ?? "");

        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== "assistant") continue;
          const tc = messages[i].parts.find(
            (p) => p.type === "tool-call" && (p as { toolCallId: string }).toolCallId === toolCallId,
          );
          if (tc && tc.type === "tool-call") {
            (tc as { output?: string }).output = outputText.slice(0, 5000);
          }
          break;
        }
        continue;
      }

      if (role !== "user" && role !== "assistant" && role !== "system") continue;

      const parts: MessagePart[] = [];

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
            parts.push({ type: "thinking", thinking: part.thinking });
          } else if (part.type === "toolCall") {
            const toolName = part.name ?? part.toolName ?? "unknown";
            const toolCallId = part.id ?? part.toolCallId ?? `tool-${Date.now()}`;
            pendingToolCalls.set(toolCallId, { toolName, args: part.arguments ?? part.input ?? part.args });
            parts.push({ type: "tool-call", toolName, toolCallId, args: part.arguments ?? part.input ?? part.args });
          } else if (part.type === "tool_use" || part.type === "tool-call") {
            const toolName = part.name ?? part.toolName ?? "unknown";
            const toolCallId = part.id ?? part.toolCallId ?? `tool-${Date.now()}`;
            pendingToolCalls.set(toolCallId, { toolName, args: part.input ?? part.args });
            parts.push({ type: "tool-call", toolName, toolCallId, args: part.input ?? part.args });
          } else if (part.type === "tool_result" || part.type === "tool-result") {
            const toolCallId = part.tool_use_id ?? part.toolCallId ?? "";
            const pending = pendingToolCalls.get(toolCallId);
            const outputText = typeof part.content === "string"
              ? part.content
              : Array.isArray(part.content)
                ? part.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n")
                : typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output ?? part.content ?? "");

            if (pending) {
              const existingMsg = messages[messages.length - 1];
              if (existingMsg) {
                const tc = existingMsg.parts.find(
                  (p) => p.type === "tool-call" && (p as { toolCallId: string }).toolCallId === toolCallId,
                );
                if (tc && tc.type === "tool-call") {
                  (tc as { output?: string }).output = outputText.slice(0, 5000);
                  continue;
                }
              }
              parts.push({ type: "tool-call", toolName: pending.toolName, toolCallId, args: pending.args, output: outputText.slice(0, 5000) });
            } else {
              parts.push({ type: "tool-call", toolName: "tool", toolCallId, output: outputText.slice(0, 5000) });
            }
          }
        }
      } else if (typeof msg.content === "string" && msg.content.trim()) {
        parts.push({ type: "text", text: msg.content });
      }

      if (parts.length > 0) {
        messages.push({
          id: entry.id ?? `msg-${messages.length}`,
          role: role as "user" | "assistant" | "system",
          parts,
          timestamp: entry.timestamp ?? new Date(entry.ts ?? Date.now()).toISOString(),
        });
      }
    } catch {}
  }

  return messages;
}

export function getCronRunTranscript(sessionId: string) {
  if (!sessionId) return { error: "Session ID required", status: 400 as const };

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) return { error: "Session not found", status: 404 as const };

  try {
    const content = readFileSync(sessionFile, "utf-8");
    const messages = parseSessionTranscript(content);
    return { data: { sessionId, messages }, status: 200 as const };
  } catch {
    return { error: "Failed to read session", status: 500 as const };
  }
}

// ── Transcript search ──

function parseMessagesInRange(
  content: string,
  opts?: { afterMs?: number; beforeMs?: number },
): ParsedMessage[] {
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const messages: ParsedMessage[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || !entry.message) continue;

      if (opts?.afterMs || opts?.beforeMs) {
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : (entry.ts ?? 0);
        if (opts.afterMs && ts < opts.afterMs) continue;
        if (opts.beforeMs && ts > opts.beforeMs) continue;
      }

      const msg = entry.message;
      const role = msg.role as "user" | "assistant" | "system";
      const parts: MessagePart[] = [];

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
            parts.push({ type: "thinking", thinking: part.thinking });
          } else if (part.type === "tool_use" || part.type === "tool-call") {
            const toolName = part.name ?? part.toolName ?? "unknown";
            const toolCallId = part.id ?? part.toolCallId ?? `tool-${Date.now()}`;
            pendingToolCalls.set(toolCallId, { toolName, args: part.input ?? part.args });
            parts.push({ type: "tool-call", toolName, toolCallId, args: part.input ?? part.args });
          } else if (part.type === "tool_result" || part.type === "tool-result") {
            const toolCallId = part.tool_use_id ?? part.toolCallId ?? "";
            const pending = pendingToolCalls.get(toolCallId);
            const outputText = typeof part.content === "string"
              ? part.content
              : Array.isArray(part.content)
                ? part.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n")
                : typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output ?? part.content ?? "");

            if (pending) {
              const existingMsg = messages[messages.length - 1];
              if (existingMsg) {
                const tc = existingMsg.parts.find(
                  (p) => p.type === "tool-call" && (p as { toolCallId: string }).toolCallId === toolCallId,
                );
                if (tc && tc.type === "tool-call") {
                  (tc as { output?: string }).output = outputText.slice(0, 5000);
                  continue;
                }
              }
              parts.push({ type: "tool-call", toolName: pending.toolName, toolCallId, args: pending.args, output: outputText.slice(0, 5000) });
            } else {
              parts.push({ type: "tool-call", toolName: "tool", toolCallId, output: outputText.slice(0, 5000) });
            }
          }
        }
      } else if (typeof msg.content === "string" && msg.content.trim()) {
        parts.push({ type: "text", text: msg.content });
      }

      if (parts.length > 0) {
        messages.push({
          id: entry.id ?? `msg-${messages.length}`,
          role,
          parts,
          timestamp: entry.timestamp ?? new Date(entry.ts ?? Date.now()).toISOString(),
        });
      }
    } catch {}
  }

  return messages;
}

function getMessageText(msg: ParsedMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function findCronSessionId(jobId: string): string | null {
  const dir = agentsDir();
  if (!existsSync(dir)) return null;
  try {
    for (const agentDir of readdirSync(dir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue;
      const sessionsJsonPath = join(dir, agentDir.name, "sessions", "sessions.json");
      if (!existsSync(sessionsJsonPath)) continue;
      try {
        const store = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
        for (const [key, entry] of Object.entries(store)) {
          if (key.includes(`:cron:${jobId}`) && !key.includes(":run:")) {
            const sessionId = (entry as { sessionId?: string })?.sessionId;
            if (typeof sessionId === "string" && sessionId.trim()) {
              const sessionFile = join(dir, agentDir.name, "sessions", `${sessionId}.jsonl`);
              if (existsSync(sessionFile)) return sessionId;
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function findCandidateSessionFiles(runAtMs: number): string[] {
  const dir = agentsDir();
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  if (!existsSync(dir)) return [];

  try {
    for (const agentDir of readdirSync(dir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue;
      const sessionsDir = join(dir, agentDir.name, "sessions");
      if (!existsSync(sessionsDir)) continue;
      try {
        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(sessionsDir, file);
          try {
            const stat = statSync(filePath);
            const windowMs = 2 * 60 * 60 * 1000;
            if (Math.abs(stat.mtimeMs - runAtMs) < windowMs) {
              candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  candidates.sort((a, b) => Math.abs(a.mtimeMs - runAtMs) - Math.abs(b.mtimeMs - runAtMs));
  return candidates.slice(0, 10).map((c) => c.path);
}

function searchForRunTranscript(
  sessionFiles: string[],
  summary: string,
  runAtMs: number,
): { messages: ParsedMessage[]; sessionFile: string } | null {
  const searchText = summary.slice(0, 80);
  const afterMs = runAtMs - 5_000;
  const beforeMs = runAtMs + 10 * 60_000;

  for (const filePath of sessionFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      if (!content.includes(searchText.slice(0, 40))) continue;

      const allMessages = parseMessagesInRange(content);

      for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i];
        if (msg.role !== "user") continue;

        const msgTs = new Date(msg.timestamp).getTime();
        if (msgTs < afterMs || msgTs > beforeMs) continue;

        const text = getMessageText(msg);
        if (!text.includes(searchText.slice(0, 40))) continue;

        const conversation: ParsedMessage[] = [msg];
        for (let j = i + 1; j < allMessages.length; j++) {
          const next = allMessages[j];
          if (next.role === "user") break;
          conversation.push(next);
        }

        return { messages: conversation, sessionFile: filePath };
      }
    } catch {}
  }

  return null;
}

export function searchCronTranscript(jobId: string, runAtMs: number, summary?: string | null) {
  if (!jobId || !Number.isFinite(runAtMs)) {
    return { error: "jobId and runAtMs are required", status: 400 as const };
  }

  const dir = agentsDir();

  // Strategy 1: cron-specific session
  const cronSessionId = findCronSessionId(jobId);
  if (cronSessionId) {
    try {
      for (const agentDir of readdirSync(dir, { withFileTypes: true })) {
        if (!agentDir.isDirectory()) continue;
        const sessionFile = join(dir, agentDir.name, "sessions", `${cronSessionId}.jsonl`);
        if (!existsSync(sessionFile)) continue;
        const content = readFileSync(sessionFile, "utf-8");
        const messages = parseMessagesInRange(content);
        if (messages.length > 0) {
          return {
            data: { sessionId: cronSessionId, messages, source: "cron-session" },
            status: 200 as const,
          };
        }
      }
    } catch {}
  }

  // Strategy 2: time-based search
  if (summary) {
    const candidates = findCandidateSessionFiles(runAtMs);
    const result = searchForRunTranscript(candidates, summary, runAtMs);
    if (result) {
      return {
        data: { messages: result.messages, source: "main-session-search" },
        status: 200 as const,
      };
    }
  }

  return { error: "Transcript not found", status: 404 as const };
}
