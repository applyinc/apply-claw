import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenClawStateDir } from "./workspace-service.js";

export type GatewaySessionEntry = {
  sessionKey: string;
  sessionId: string;
  channel: string;
  origin: {
    label?: string;
    provider: string;
    surface: string;
    chatType: string;
    from?: string;
    to?: string;
    accountId?: string;
  };
  updatedAt: number;
  chatType: string;
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: Array<Record<string, unknown>>;
  timestamp: string;
};

function deriveChannelFromKey(sessionKey: string, lastChannel?: string): string {
  if (lastChannel && lastChannel !== "unknown") return lastChannel;
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    const segment = parts[2];
    if (segment === "web" || segment === "main") return "webchat";
    if (segment === "cron") return "cron";
    if (["telegram", "whatsapp", "discord", "slack", "signal", "imessage", "nostr", "googlechat"].includes(segment)) {
      return segment;
    }
  }
  return lastChannel || "unknown";
}

function readGatewaySessionsForAgent(agentId: string): GatewaySessionEntry[] {
  const sessionsFile = join(resolveOpenClawStateDir(), "agents", agentId, "sessions", "sessions.json");
  if (!existsSync(sessionsFile)) return [];
  let data: Record<string, Record<string, unknown>>;
  try {
    data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
  } catch {
    return [];
  }
  const entries: GatewaySessionEntry[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.includes(":subagent:")) continue;
    const channel = deriveChannelFromKey(key, value.lastChannel as string | undefined);
    if (channel === "webchat" || channel === "unknown") continue;
    const origin = (value.origin ?? {}) as Record<string, unknown>;
    entries.push({
      sessionKey: key,
      sessionId: value.sessionId as string,
      channel,
      origin: {
        label: origin.label as string | undefined,
        provider: (origin.provider ?? channel) as string,
        surface: (origin.surface ?? channel) as string,
        chatType: (origin.chatType ?? value.chatType ?? "direct") as string,
        from: origin.from as string | undefined,
        to: origin.to as string | undefined,
        accountId: origin.accountId as string | undefined,
      },
      updatedAt: value.updatedAt as number ?? 0,
      chatType: (value.chatType ?? "direct") as string,
    });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

function listAllAgentIds(): string[] {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function findSessionTranscriptFile(sessionId: string): string | null {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");
  if (!existsSync(agentsDir)) return null;
  try {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(agentsDir, entry.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(filePath)) return filePath;
    }
  } catch {}
  return null;
}

function parseTranscriptToMessages(content: string): TranscriptMessage[] {
  const lines = content.trim().split("\n").filter((line) => line.trim());
  const messages: TranscriptMessage[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();
  let currentAssistant: TranscriptMessage | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    currentAssistant.content = (currentAssistant.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .slice(0, 200);
    messages.push(currentAssistant);
    currentAssistant = null;
  };

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message as Record<string, unknown>;
    const role = message.role as string;
    if (role === "toolResult") {
      const toolCallId = (message.toolCallId as string) ?? "";
      const rawContent = message.content;
      const outputText = typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? (rawContent as Array<{ type: string; text?: string }>)
              .filter((chunk) => chunk.type === "text")
              .map((chunk) => chunk.text ?? "")
              .join("\n")
          : JSON.stringify(rawContent ?? "");
      let result: unknown;
      try {
        result = JSON.parse(outputText);
      } catch {
        result = { output: outputText.slice(0, 5000) };
      }
      const assistantParts = currentAssistant?.parts;
      if (assistantParts) {
        const toolCall = assistantParts.find((part) => part.type === "tool-invocation" && part.toolCallId === toolCallId);
        if (toolCall) {
          delete toolCall.state;
          toolCall.result = result;
          continue;
        }
      }
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role !== "assistant") continue;
        const toolCall = messages[index].parts?.find((part) => part.type === "tool-invocation" && part.toolCallId === toolCallId);
        if (toolCall) {
          delete toolCall.state;
          toolCall.result = result;
        }
        break;
      }
      continue;
    }

    if (role === "user") flushAssistant();
    if (role !== "user" && role !== "assistant") continue;
    const parts: Array<Record<string, unknown>> = [];

    if (Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          parts.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "toolCall" || part.type === "tool_use" || part.type === "tool-call") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.arguments ?? part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        } else if (part.type === "tool_result" || part.type === "tool-result") {
          const toolCallId = (part.tool_use_id ?? part.toolCallId ?? "") as string;
          const pending = pendingToolCalls.get(toolCallId);
          const raw = part.content ?? part.output;
          const outputText = typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type: string; text?: string }>).filter((chunk) => chunk.type === "text").map((chunk) => chunk.text ?? "").join("\n")
              : JSON.stringify(raw ?? "");
          let result: unknown;
          try {
            result = JSON.parse(outputText);
          } catch {
            result = { output: outputText.slice(0, 5000) };
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
    } else if (typeof message.content === "string" && message.content.trim()) {
      parts.push({ type: "text", text: message.content });
    }

    if (parts.length === 0) continue;
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
  flushAssistant();
  return messages;
}

export type ChannelStatus = {
  id: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  error?: string;
  lastMessage?: number;
};

const KNOWN_CHANNELS = [
  "whatsapp", "telegram", "discord", "googlechat",
  "slack", "signal", "imessage", "nostr",
] as const;

function readConfiguredChannels(): Record<string, { enabled?: boolean }> {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return (config.channels ?? {}) as Record<string, { enabled?: boolean }>;
  } catch {
    return {};
  }
}

export function getGatewayChannelsConfigOnly(): { channels: ChannelStatus[] } {
  const configuredChannels = readConfiguredChannels();
  const channels: ChannelStatus[] = [];

  for (const channelId of KNOWN_CHANNELS) {
    const channelConfig = configuredChannels[channelId];
    if (!channelConfig) continue;

    const enabled = channelConfig.enabled !== false;

    channels.push({
      id: channelId,
      configured: true,
      running: enabled,
      connected: false,
      error: undefined,
      lastMessage: undefined,
    });
  }

  return { channels };
}

/**
 * Get gateway channels with live status from the gateway RPC.
 * Falls back to config-only data if the gateway is unreachable.
 */
export async function getGatewayChannels(): Promise<{ channels: ChannelStatus[] }> {
  const { callGatewayRpc } = await import("./gateway-rpc-client.js");
  try {
    const result = await callGatewayRpc("channels.status", {}, { retries: 1, timeoutMs: 5_000 });
    if (result.ok && result.payload) {
      const payload = result.payload as { channels?: Array<Record<string, unknown>> };
      if (Array.isArray(payload.channels)) {
        return {
          channels: payload.channels.map((ch) => ({
            id: (ch.id ?? ch.channel ?? "") as string,
            configured: ch.configured !== false,
            running: ch.running === true,
            connected: ch.connected === true,
            error: typeof ch.error === "string" ? ch.error : undefined,
            lastMessage: typeof ch.lastMessage === "number" ? ch.lastMessage : undefined,
          })),
        };
      }
    }
  } catch {
    // Gateway unreachable — fall back to config-only
  }
  return getGatewayChannelsConfigOnly();
}

export function getGatewaySessions(activeAgentId: string, channelFilter?: string | null) {
  const agentIds = listAllAgentIds();
  const prioritized = [activeAgentId, ...agentIds.filter((id) => id !== activeAgentId)];
  const seen = new Set<string>();
  let sessions = prioritized.flatMap((agentId) => readGatewaySessionsForAgent(agentId))
    .filter((session) => {
      if (seen.has(session.sessionKey)) return false;
      seen.add(session.sessionKey);
      return true;
    });
  if (channelFilter) {
    sessions = sessions.filter((session) => session.channel === channelFilter);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions };
}

export function getGatewaySessionMessages(sessionId: string) {
  const transcriptFile = findSessionTranscriptFile(sessionId);
  if (!transcriptFile) {
    return { error: "Session not found", status: 404 as const };
  }
  const content = readFileSync(transcriptFile, "utf-8");
  return {
    data: {
      id: sessionId,
      messages: parseTranscriptToMessages(content),
    },
    status: 200 as const,
  };
}
