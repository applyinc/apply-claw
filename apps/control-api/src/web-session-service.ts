import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getActiveWorkspaceName,
  resolveActiveAgentId,
  resolveOpenClawStateDir,
  resolveWebChatDir,
  resolveWorkspaceDirForName,
  resolveWorkspaceRoot,
} from "./workspace-service.js";

// ── Types ──

export type WebSessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  filePath?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  workspaceAgentId?: string;
  chatAgentId?: string;
  gatewaySessionKey?: string;
  agentMode?: "workspace" | "ephemeral";
  lastActiveAt?: number;
};

type ChatLine = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: Array<Record<string, unknown>>;
  timestamp: string;
};

// ── Shared helpers ──

function ensureDir(): string {
  const dir = resolveWebChatDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readIndex(): WebSessionMeta[] {
  const dir = ensureDir();
  const indexFile = join(dir, "index.json");
  let index: WebSessionMeta[] = [];
  if (existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, "utf-8"));
    } catch {
      index = [];
    }
  }

  // Scan for orphaned .jsonl files not in the index
  try {
    const indexed = new Set(index.map((s) => s.id));
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    let dirty = false;
    for (const file of files) {
      const id = file.replace(/\.jsonl$/, "");
      if (indexed.has(id)) continue;

      const fp = join(dir, file);
      const stat = statSync(fp);
      let title = "New Chat";
      let messageCount = 0;
      try {
        const content = readFileSync(fp, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        messageCount = lines.length;
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.role === "user" && parsed.content) {
            const text = String(parsed.content);
            title = text.length > 60 ? text.slice(0, 60) + "..." : text;
            break;
          }
        }
      } catch {}

      index.push({
        id,
        title,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        messageCount,
      });
      dirty = true;
    }

    if (dirty) {
      index.sort((a, b) => b.updatedAt - a.updatedAt);
      writeFileSync(indexFile, JSON.stringify(index, null, 2));
    }
  } catch {}

  return index;
}

/** Look up a session's pinned metadata by ID. */
export function getSessionMeta(sessionId: string): WebSessionMeta | undefined {
  return readIndex().find((s) => s.id === sessionId);
}

/** Resolve the gateway session key for a session. */
export function resolveSessionKey(sessionId: string, fallbackAgentId: string): string {
  const meta = getSessionMeta(sessionId);
  if (meta?.gatewaySessionKey && !meta.gatewaySessionKey.includes(":chat-slot-")) {
    return meta.gatewaySessionKey;
  }
  const agentId = meta?.workspaceAgentId ?? fallbackAgentId;
  return `agent:${agentId}:web:${sessionId}`;
}

function writeIndex(sessions: WebSessionMeta[]) {
  const dir = ensureDir();
  writeFileSync(join(dir, "index.json"), JSON.stringify(sessions, null, 2));
}

// ── Agent session fallback ──

function findAgentSessionFile(sessionId: string): string | null {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");
  if (!existsSync(agentsDir)) return null;
  try {
    for (const d of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(agentsDir, d.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function parseAgentTranscriptToChatLines(content: string): ChatLine[] {
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const messages: ChatLine[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();
  let currentAssistant: ChatLine | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    const textSummary = (currentAssistant.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .slice(0, 200);
    currentAssistant.content = textSummary;
    messages.push(currentAssistant);
    currentAssistant = null;
  };

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message as Record<string, unknown>;
    const role = msg.role as string;

    if (role === "toolResult") {
      const toolCallId = msg.toolCallId as string ?? "";
      const rawContent = msg.content;
      const outputText = typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? (rawContent as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
          : JSON.stringify(rawContent ?? "");
      let result: unknown;
      try { result = JSON.parse(outputText); } catch { result = { output: outputText.slice(0, 5000) }; }

      const assistantParts = currentAssistant?.parts;
      if (assistantParts) {
        const tc = assistantParts.find((p) => p.type === "tool-invocation" && p.toolCallId === toolCallId);
        if (tc) {
          delete tc.state;
          tc.result = result;
          continue;
        }
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== "assistant") continue;
        const tc = messages[i].parts?.find((p) => p.type === "tool-invocation" && p.toolCallId === toolCallId);
        if (tc) {
          delete tc.state;
          tc.result = result;
        }
        break;
      }
      continue;
    }

    if (role === "user") flushAssistant();
    if (role !== "user" && role !== "assistant") continue;

    const parts: Array<Record<string, unknown>> = [];

    if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          parts.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "toolCall") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.arguments ?? part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        } else if (part.type === "tool_use" || part.type === "tool-call") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        } else if (part.type === "tool_result" || part.type === "tool-result") {
          const toolCallId = (part.tool_use_id ?? part.toolCallId ?? "") as string;
          const pending = pendingToolCalls.get(toolCallId);
          const raw = part.content ?? part.output;
          const outputText = typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
              : JSON.stringify(raw ?? "");
          let result: unknown;
          try { result = JSON.parse(outputText); } catch { result = { output: outputText.slice(0, 5000) }; }

          const existingMsg = messages[messages.length - 1];
          if (existingMsg) {
            const tc = existingMsg.parts?.find((p) => p.type === "tool-invocation" && p.toolCallId === toolCallId);
            if (tc) {
              delete tc.state;
              tc.result = result;
              continue;
            }
          }
          parts.push({
            type: "tool-invocation",
            toolCallId,
            toolName: pending?.toolName ?? "tool",
            args: pending?.args ?? {},
            result,
          });
        }
      }
    } else if (typeof msg.content === "string" && msg.content.trim()) {
      parts.push({ type: "text", text: msg.content });
    }

    if (parts.length > 0) {
      const timestamp = (entry.timestamp as string) ?? new Date((entry.ts as number) ?? Date.now()).toISOString();
      if (role === "assistant") {
        if (!currentAssistant) {
          currentAssistant = {
            id: (entry.id as string) ?? `msg-${messages.length}`,
            role: "assistant",
            content: "",
            parts: [],
            timestamp,
          };
        }
        currentAssistant.parts = [...(currentAssistant.parts ?? []), ...parts];
        currentAssistant.timestamp = timestamp;
      } else {
        messages.push({
          id: (entry.id as string) ?? `msg-${messages.length}`,
          role: "user",
          content: parts
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n")
            .slice(0, 200),
          parts,
          timestamp,
        });
      }
    }
  }
  flushAssistant();
  return messages;
}

// ── API handlers ──

export function listWebSessions(filePath?: string | null, includeAll?: boolean) {
  const all = readIndex();
  const sessions = includeAll
    ? all
    : filePath
      ? all.filter((s) => s.filePath === filePath)
      : all.filter((s) => !s.filePath);
  return { sessions };
}

export function createWebSession(body: Record<string, unknown>) {
  const id = randomUUID();
  const now = Date.now();

  const workspaceName = getActiveWorkspaceName() ?? "default";
  const workspaceRootDir = resolveWorkspaceRoot() ?? resolveWorkspaceDirForName(workspaceName);
  const workspaceAgentId = resolveActiveAgentId();
  const gatewaySessionKey = `agent:${workspaceAgentId}:web:${id}`;

  const session: WebSessionMeta = {
    id,
    title: (body.title as string) || "New Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...(body.filePath ? { filePath: body.filePath as string } : {}),
    workspaceName: workspaceName || undefined,
    workspaceRoot: workspaceRootDir,
    workspaceAgentId,
    gatewaySessionKey,
    agentMode: "workspace",
    lastActiveAt: now,
  };

  const sessions = readIndex();
  sessions.unshift(session);
  writeIndex(sessions);

  const dir = ensureDir();
  writeFileSync(`${dir}/${id}.jsonl`, "");

  return { data: { session }, status: 200 as const };
}

export function getWebSession(id: string) {
  const filePath = join(resolveWebChatDir(), `${id}.jsonl`);

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const messages: ChatLine[] = content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ChatLine; } catch { return null; }
      })
      .filter((m): m is ChatLine => m !== null);
    return { data: { id, messages }, status: 200 as const };
  }

  // Fallback: search agent session directories
  const agentFile = findAgentSessionFile(id);
  if (agentFile) {
    const content = readFileSync(agentFile, "utf-8");
    const messages = parseAgentTranscriptToChatLines(content);
    return { data: { id, messages }, status: 200 as const, source: "agent" };
  }

  return { error: "Session not found", status: 404 as const };
}

export function deleteWebSession(id: string) {
  const sessions = readIndex();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return { error: "Session not found", status: 404 as const };

  sessions.splice(idx, 1);
  writeIndex(sessions);

  const filePath = join(resolveWebChatDir(), `${id}.jsonl`);
  if (existsSync(filePath)) unlinkSync(filePath);

  return { data: { ok: true }, status: 200 as const };
}

export function updateWebSession(id: string, body: Record<string, unknown>) {
  const sessions = readIndex();
  const session = sessions.find((s) => s.id === id);
  if (!session) return { error: "Session not found", status: 404 as const };

  if (typeof body.title === "string") session.title = body.title;
  session.updatedAt = Date.now();
  writeIndex(sessions);

  return { data: { session }, status: 200 as const };
}

export function upsertWebSessionMessages(id: string, body: { messages: Array<Record<string, unknown>>; title?: string }) {
  const chatDir = resolveWebChatDir();
  const filePath = join(chatDir, `${id}.jsonl`);
  const indexPath = join(chatDir, "index.json");

  if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
  if (!existsSync(filePath)) writeFileSync(filePath, "");

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: "messages array required", status: 400 as const };
  }

  const existing = readFileSync(filePath, "utf-8");
  const lines = existing.split("\n").filter((l) => l.trim());
  let newCount = 0;

  for (const msg of body.messages) {
    const msgId = typeof msg.id === "string" ? msg.id : undefined;
    let found = false;

    if (msgId) {
      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.id === msgId) {
            lines[i] = JSON.stringify(msg);
            found = true;
            break;
          }
        } catch {}
      }
    }

    if (!found) {
      lines.push(JSON.stringify(msg));
      newCount++;
    }
  }

  writeFileSync(filePath, lines.join("\n") + "\n");

  // Update index metadata
  try {
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, "utf-8")) as Array<{ id: string; updatedAt: number; messageCount: number; title: string }>;
      const session = index.find((s) => s.id === id);
      if (session) {
        session.updatedAt = Date.now();
        if (newCount > 0) session.messageCount += newCount;
        if (body.title) session.title = body.title;
        writeFileSync(indexPath, JSON.stringify(index, null, 2));
      }
    }
  } catch {}

  return { data: { ok: true }, status: 200 as const };
}
