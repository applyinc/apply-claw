import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenClawStateDir } from "./workspace-service.js";

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  label?: string;
  displayName?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  compactionCount?: number;
};

type SessionRow = {
  key: string;
  sessionId: string;
  updatedAt: number;
  label?: string;
  displayName?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
};

export function listAllSessions() {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");

  if (!existsSync(agentsDir)) {
    return { agents: [], sessions: [] };
  }

  const allSessions: SessionRow[] = [];
  const agentIds: string[] = [];

  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      agentIds.push(entry.name);

      const storePath = join(agentsDir, entry.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) continue;

      try {
        const raw = readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, SessionEntry>;
        for (const [key, session] of Object.entries(store)) {
          if (!session || typeof session !== "object") continue;
          allSessions.push({
            key,
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            label: session.label,
            displayName: session.displayName,
            channel: session.channel,
            model: session.model,
            modelProvider: session.modelProvider,
            thinkingLevel: session.thinkingLevel,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            totalTokens: session.totalTokens,
            contextTokens: session.contextTokens,
          });
        }
      } catch {
        // skip unreadable store files
      }
    }
  } catch {
    // agents dir unreadable
  }

  allSessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return { agents: agentIds, sessions: allSessions };
}

function findSessionFile(sessionId: string): string | null {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");
  if (!existsSync(agentsDir)) return null;

  try {
    const agentDirs = readdirSync(agentsDir, { withFileTypes: true });
    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) continue;
      const sessionFile = join(agentsDir, agentDir.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) return sessionFile;
    }
  } catch {}

  return null;
}

export function getSessionTranscript(sessionId: string) {
  if (!sessionId) {
    return { error: "Session ID required", status: 400 as const };
  }

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    return { error: "Session not found", status: 404 as const };
  }

  try {
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n").filter((line) => line.trim());

    const messages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          type: string;
          id: string;
          timestamp: string;
          message?: {
            role: "user" | "assistant";
            content: Array<
              | { type: "text"; text: string }
              | { type: "thinking"; thinking: string }
            >;
          };
        };

        if (entry.type === "message" && entry.message) {
          const textContent = entry.message.content
            .filter((part) => part.type === "text" || part.type === "thinking")
            .map((part) => {
              if (part.type === "text") return (part as { type: "text"; text: string }).text;
              if (part.type === "thinking") return `[Thinking: ${(part as { type: "thinking"; thinking: string }).thinking.slice(0, 100)}...]`;
              return "";
            })
            .join("\n");

          if (textContent) {
            messages.push({
              id: entry.id,
              role: entry.message.role,
              content: textContent,
              timestamp: entry.timestamp,
            });
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    return { data: { sessionId, messages }, status: 200 as const };
  } catch {
    return { error: "Failed to read session", status: 500 as const };
  }
}
