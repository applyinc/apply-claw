import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

import { getActiveWorkspaceName, listWorkspaces, resolveOpenClawStateDir, resolveWorkspaceRoot, switchWorkspace } from "./workspace-service.js";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_MODEL = "openai-codex/gpt-5.4";
const MAIN_AGENT_ID = "main";
const SESSION_TTL_MS = 15 * 60_000;

type JsonRecord = Record<string, unknown>;

type AuthProfileRecord = {
  type?: string;
  provider?: string;
  accountId?: string;
  label?: string;
  displayName?: string;
  email?: string;
  login?: string;
};

type AuthProfilesFile = {
  version?: number;
  profiles?: Record<string, AuthProfileRecord>;
  auth?: {
    order?: Record<string, string[] | string>;
  };
  order?: Record<string, string[] | string>;
};

export type AuthProfileSummary = {
  id: string;
  provider: string;
  label: string;
  accountId: string | null;
  isCurrent: boolean;
};

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

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export function resolveAuthProfilesPath(agentId = MAIN_AGENT_ID): string {
  return join(resolveOpenClawStateDir(), "agents", agentId, "agent", "auth-profiles.json");
}

export function readAuthProfilesFile(agentId = MAIN_AGENT_ID): AuthProfilesFile {
  return readJsonFile<AuthProfilesFile>(resolveAuthProfilesPath(agentId), { version: 1, profiles: {} });
}

function readProviderOrder(raw: AuthProfilesFile, provider: string): string[] {
  const nested = raw.auth?.order?.[provider];
  if (Array.isArray(nested)) {
    return nested.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  if (typeof nested === "string" && nested.trim()) {
    return [nested.trim()];
  }
  const legacy = raw.order?.[provider];
  if (Array.isArray(legacy)) {
    return legacy.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  if (typeof legacy === "string" && legacy.trim()) {
    return [legacy.trim()];
  }
  return [];
}

export function getCurrentProfileId(raw: AuthProfilesFile, provider: string): string | null {
  return readProviderOrder(raw, provider)[0] ?? null;
}

function writeCurrentProfileId(raw: AuthProfilesFile, provider: string, profileId: string | null): AuthProfilesFile {
  const next: AuthProfilesFile = {
    ...raw,
    auth: {
      ...(raw.auth ?? {}),
      order: {
        ...(raw.auth?.order ?? {}),
      },
    },
  };

  if (!profileId) {
    delete next.auth?.order?.[provider];
    if (next.order?.[provider] !== undefined) {
      const legacy = { ...(next.order ?? {}) };
      delete legacy[provider];
      next.order = legacy;
    }
    return next;
  }

  next.auth!.order![provider] = [profileId];
  if (next.order?.[provider] !== undefined) {
    next.order = { ...(next.order ?? {}), [provider]: [profileId] };
  }
  return next;
}

function buildProfileLabel(id: string, profile: AuthProfileRecord): string {
  const candidates = [profile.label, profile.displayName, profile.email, profile.login, profile.accountId, id];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? id;
}

export function listProviderProfiles(provider: string, agentId = MAIN_AGENT_ID): AuthProfileSummary[] {
  const raw = readAuthProfilesFile(agentId);
  const currentProfileId = getCurrentProfileId(raw, provider);
  const profiles = Object.entries(raw.profiles ?? {})
    .filter(([, profile]) => profile?.provider === provider)
    .map(([id, profile]) => ({
      id,
      provider,
      label: buildProfileLabel(id, profile),
      accountId: typeof profile.accountId === "string" ? profile.accountId : null,
      isCurrent: id === currentProfileId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!profiles.some((profile) => profile.isCurrent) && profiles.length > 0 && !currentProfileId) {
    profiles[0] = { ...profiles[0], isCurrent: true };
  }
  return profiles;
}

export function setSelectedProfile(provider: string, profileId: string, agentId = MAIN_AGENT_ID): AuthProfileSummary[] {
  const raw = readAuthProfilesFile(agentId);
  const profile = raw.profiles?.[profileId];
  if (!profile || profile.provider !== provider) {
    throw new Error("Selected auth profile was not found.");
  }
  const next = writeCurrentProfileId(raw, provider, profileId);
  writeJsonFile(resolveAuthProfilesPath(agentId), next);
  return listProviderProfiles(provider, agentId);
}

export function disconnectProfile(provider: string, profileId: string, agentId = MAIN_AGENT_ID): AuthProfileSummary[] {
  const raw = readAuthProfilesFile(agentId);
  const nextProfiles = { ...(raw.profiles ?? {}) };
  const current = nextProfiles[profileId];
  if (!current || current.provider !== provider) {
    throw new Error("Auth profile was not found.");
  }
  delete nextProfiles[profileId];
  const remaining = Object.entries(nextProfiles)
    .filter(([, profile]) => profile?.provider === provider)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
  const next = writeCurrentProfileId({ ...raw, profiles: nextProfiles }, provider, remaining[0] ?? null);
  writeJsonFile(resolveAuthProfilesPath(agentId), next);
  return listProviderProfiles(provider, agentId);
}

export function ensurePrimaryModel(modelId = OPENAI_CODEX_MODEL): void {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  const current = readJsonFile<JsonRecord>(configPath, {});
  const next: JsonRecord = {
    ...current,
    agents: {
      ...(((current.agents as JsonRecord | undefined) ?? {})),
      defaults: {
        ...((((current.agents as JsonRecord | undefined)?.defaults as JsonRecord | undefined) ?? {})),
        model: {
          ...(((((current.agents as JsonRecord | undefined)?.defaults as JsonRecord | undefined)?.model as JsonRecord | undefined) ?? {})),
          primary: modelId,
        },
      },
    },
  };
  writeJsonFile(configPath, next);
}

function parseOpenClawVersion(raw: string): number[] | null {
  const match = raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  return match.slice(1).map((segment) => Number.parseInt(segment, 10));
}

function compareVersions(left: number[] | null, right: number[] | null): number {
  const l = left ?? [0, 0, 0];
  const r = right ?? [0, 0, 0];
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const lv = l[index] ?? 0;
    const rv = r[index] ?? 0;
    if (lv !== rv) return lv - rv;
  }
  return 0;
}

async function readCommandVersionAsync(commandPath: string): Promise<number[] | null> {
  try {
    const { stdout } = await execFile(commandPath, ["--version"], {
      encoding: "utf-8",
      env: process.env,
    });
    return parseOpenClawVersion(stdout);
  } catch {
    return null;
  }
}

let cachedOpenClawCommand: string | null = null;

export async function resolveOpenClawCommandAsync(): Promise<string> {
  if (cachedOpenClawCommand) {
    return cachedOpenClawCommand;
  }
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const args = process.platform === "win32" ? ["openclaw"] : ["-a", "openclaw"];
    const { stdout } = await execFile(locator, args, { encoding: "utf-8" });
    const candidates = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (candidates.length === 0) {
      throw new Error("openclaw command not found");
    }
    const versioned = await Promise.all(
      candidates.map(async (candidate) => ({ path: candidate, version: await readCommandVersionAsync(candidate) })),
    );
    const resolved = versioned.sort((a, b) => compareVersions(b.version, a.version))[0]?.path ?? candidates[0]!;
    cachedOpenClawCommand = resolved;
    return resolved;
  } catch {
    throw new Error("OpenClaw CLI was not found on PATH.");
  }
}

export function resolveOpenClawCommandOrThrow(): string {
  if (cachedOpenClawCommand) {
    return cachedOpenClawCommand;
  }
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const args = process.platform === "win32" ? ["openclaw"] : ["-a", "openclaw"];
    const output = execFileSync(locator, args, { encoding: "utf-8" }).trim();
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (candidates.length === 0) {
      throw new Error("openclaw command not found");
    }
    const resolved = candidates[0]!;
    cachedOpenClawCommand = resolved;
    return resolved;
  } catch {
    throw new Error("OpenClaw CLI was not found on PATH.");
  }
}

function buildOpenClawEnv(): NodeJS.ProcessEnv {
  const stateDir = resolveOpenClawStateDir();
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_HOME: dirname(stateDir),
    OPENCLAW_PROFILE: "dench",
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function firstNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
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

export async function startOpenAiCodexLoginSession(): Promise<ModelAuthLoginSession> {
  cleanExpiredSessions();
  const existing = [...sessions().values()].find(
    (session) => session.provider === OPENAI_CODEX_PROVIDER && session.status === "running",
  );
  if (existing) {
    return currentSessionSnapshot(existing);
  }

  const command = await resolveOpenClawCommandAsync();
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

  const ttyCommand = process.platform === "darwin"
    ? {
        command: "/usr/bin/script",
        args: ["-q", "/dev/null", command, "models", "auth", "login", "--provider", OPENAI_CODEX_PROVIDER],
      }
    : {
        command,
        args: ["models", "auth", "login", "--provider", OPENAI_CODEX_PROVIDER],
      };

  const child = spawn(ttyCommand.command, ttyCommand.args, {
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.process = child;
  sessions().set(id, session);

  const appendOutput = (data: string) => {
    session.output = (session.output + data).slice(-24_000);
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
  child.on("exit", () => {
    session.finishedAt = Date.now();
    session.process = undefined;
    if (listProviderProfiles(OPENAI_CODEX_PROVIDER).length >= before.length) {
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

export function getModelAuthSummary() {
  const profiles = listProviderProfiles(OPENAI_CODEX_PROVIDER);
  const currentProfileId = getCurrentProfileId(readAuthProfilesFile(), OPENAI_CODEX_PROVIDER);
  return {
    currentProfileId,
    model: OPENAI_CODEX_MODEL,
    profiles,
    provider: OPENAI_CODEX_PROVIDER,
  };
}

export function listProfilesSummary() {
  const { workspaces } = listWorkspaces();
  const activeWorkspace = getActiveWorkspaceName() ?? workspaces.find((item) => item.isActive)?.name ?? null;
  return {
    activeProfile: activeWorkspace,
    activeWorkspace,
    profiles: workspaces,
    workspaces,
  };
}

export function switchProfileSummary(workspace: string) {
  const result = switchWorkspace(workspace);
  const selected = listWorkspaces().workspaces.find((item) => item.name === result.activeWorkspace) ?? null;
  return {
    activeProfile: result.activeWorkspace,
    activeWorkspace: result.activeWorkspace,
    profile: selected,
    stateDir: resolveOpenClawStateDir(),
    workspace: selected,
    workspaceRoot: resolveWorkspaceRoot(),
  };
}
