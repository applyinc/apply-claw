import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveOpenClawStateDir } from "./workspace";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_MODEL = "openai-codex/gpt-5.4";
const MAIN_AGENT_ID = "main";

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

export function resolveAuthProfilesPath(agentId = MAIN_AGENT_ID): string {
  return join(resolveOpenClawStateDir(), "agents", agentId, "agent", "auth-profiles.json");
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

export function writeCurrentProfileId(raw: AuthProfilesFile, provider: string, profileId: string | null): AuthProfilesFile {
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
    next.order = {
      ...(next.order ?? {}),
      [provider]: [profileId],
    };
  }
  return next;
}

function buildProfileLabel(id: string, profile: AuthProfileRecord): string {
  const candidates = [
    profile.label,
    profile.displayName,
    profile.email,
    profile.login,
    profile.accountId,
    id,
  ];
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

  const next = writeCurrentProfileId(
    {
      ...raw,
      profiles: nextProfiles,
    },
    provider,
    remaining[0] ?? null,
  );

  writeJsonFile(resolveAuthProfilesPath(agentId), next);
  return listProviderProfiles(provider, agentId);
}

export function ensurePrimaryModel(modelId = OPENAI_CODEX_MODEL): void {
  const stateDir = resolveOpenClawStateDir();
  const configPath = join(stateDir, "openclaw.json");
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

export function parseOpenClawVersion(raw: string): number[] | null {
  const match = raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((segment) => Number.parseInt(segment, 10));
}

export function compareVersions(left: number[] | null, right: number[] | null): number {
  const l = left ?? [0, 0, 0];
  const r = right ?? [0, 0, 0];
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const lv = l[index] ?? 0;
    const rv = r[index] ?? 0;
    if (lv !== rv) {
      return lv - rv;
    }
  }
  return 0;
}

export function readCommandVersion(commandPath: string): number[] | null {
  try {
    const output = execFileSync(commandPath, ["--version"], {
      encoding: "utf-8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseOpenClawVersion(output);
  } catch {
    return null;
  }
}

export function resolveOpenClawCommandOrThrow(): string {
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const args = process.platform === "win32" ? ["openclaw"] : ["-a", "openclaw"];
    const output = execFileSync(locator, args, { encoding: "utf-8" }).trim();
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (candidates.length === 0) {
      throw new Error("openclaw command not found");
    }

    return candidates
      .map((candidate) => ({
        path: candidate,
        version: readCommandVersion(candidate),
      }))
      .sort((a, b) => compareVersions(b.version, a.version))[0]?.path ?? candidates[0]!;
  } catch {
    throw new Error("OpenClaw CLI was not found on PATH.");
  }
}

export function buildOpenClawEnv(): NodeJS.ProcessEnv {
  const stateDir = resolveOpenClawStateDir();
  return {
    ...process.env,
    OPENCLAW_PROFILE: "dench",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_HOME: dirname(stateDir),
  };
}

function firstNonEmptyLine(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const first = value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return null;
}
