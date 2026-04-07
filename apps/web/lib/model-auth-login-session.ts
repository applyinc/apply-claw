import { spawn } from "node:child_process";

import type { AuthProfileSummary } from "./model-auth";
import {
  buildOpenClawEnv,
  ensurePrimaryModel,
  listProviderProfiles,
  OPENAI_CODEX_PROVIDER,
  resolveOpenClawCommandOrThrow,
  setSelectedProfile,
} from "./model-auth";

type LoginSessionStatus = "running" | "completed" | "failed";

export type ModelAuthLoginSession = {
  id: string;
  provider: string;
  status: LoginSessionStatus;
  output: string;
  startedAt: number;
  finishedAt: number | null;
  message: string | null;
  profiles: AuthProfileSummary[];
};

type StoredSession = ModelAuthLoginSession & {
  process?: ReturnType<typeof spawn>;
};

const SESSION_TTL_MS = 15 * 60_000;

const globalState = globalThis as typeof globalThis & {
  __openAiLoginSessions?: Map<string, StoredSession>;
};

function sessions(): Map<string, StoredSession> {
  if (!globalState.__openAiLoginSessions) {
    globalState.__openAiLoginSessions = new Map();
  }
  return globalState.__openAiLoginSessions;
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions()) {
    if (session.finishedAt && now - session.finishedAt > SESSION_TTL_MS) {
      session.process?.kill();
      sessions().delete(id);
    }
  }
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function currentSessionSnapshot(session: StoredSession): ModelAuthLoginSession {
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    output: session.output,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    message: session.message,
    profiles: session.profiles,
  };
}

export function getLoginSession(sessionId: string): ModelAuthLoginSession | null {
  cleanExpiredSessions();
  const session = sessions().get(sessionId);
  return session ? currentSessionSnapshot(session) : null;
}

export function startOpenAiCodexLoginSession(): ModelAuthLoginSession {
  cleanExpiredSessions();
  const existing = [...sessions().values()].find(
    (session) => session.provider === OPENAI_CODEX_PROVIDER && session.status === "running",
  );
  if (existing) {
    return currentSessionSnapshot(existing);
  }

  const command = resolveOpenClawCommandOrThrow();
  const env = buildOpenClawEnv();
  const id = crypto.randomUUID();
  const before = listProviderProfiles(OPENAI_CODEX_PROVIDER).map((profile) => profile.id);

  const session: StoredSession = {
    id,
    provider: OPENAI_CODEX_PROVIDER,
    status: "running",
    output: "",
    startedAt: Date.now(),
    finishedAt: null,
    message: null,
    profiles: listProviderProfiles(OPENAI_CODEX_PROVIDER),
  };

  const ttyCommand =
    process.platform === "darwin"
      ? {
          command: "/usr/bin/script",
          args: ["-q", "/dev/null", command, "models", "auth", "login", "--provider", OPENAI_CODEX_PROVIDER],
        }
      : {
          command,
          args: ["models", "auth", "login", "--provider", OPENAI_CODEX_PROVIDER],
        };

  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;

  const child = spawn(ttyCommand.command, ttyCommand.args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.process = child;
  sessions().set(id, session);

  const appendOutput = (data: string) => {
    const nextOutput = (session.output + data).slice(-24_000);
    session.output = nextOutput;
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    appendOutput(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    appendOutput(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  });

  child.on("error", (error) => {
    session.finishedAt = Date.now();
    session.process = undefined;
    session.status = "failed";
    session.message = error.message;
    appendOutput(`\n${error.message}\n`);
  });

  child.on("exit", (exitCode) => {
    session.finishedAt = Date.now();
    session.process = undefined;

    if (exitCode === 0) {
      ensurePrimaryModel();
      const after = listProviderProfiles(OPENAI_CODEX_PROVIDER);
      const added = after.filter((profile) => !before.includes(profile.id));
      const nextCurrentId = added[0]?.id ?? after.find((profile) => profile.isCurrent)?.id ?? after[0]?.id ?? null;
      if (nextCurrentId) {
        setSelectedProfile(OPENAI_CODEX_PROVIDER, nextCurrentId);
      }
      session.status = "completed";
      session.profiles = listProviderProfiles(OPENAI_CODEX_PROVIDER);
      session.message = firstNonEmptyLine(session.output) ?? "OpenAI account connected.";
      return;
    }

    session.status = "failed";
    session.profiles = listProviderProfiles(OPENAI_CODEX_PROVIDER);
    session.message = firstNonEmptyLine(session.output) ?? "OpenClaw login failed.";
  });

  return currentSessionSnapshot(session);
}
