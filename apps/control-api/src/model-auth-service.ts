import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getActiveWorkspaceName, listWorkspaces, resolveOpenClawStateDir, resolveWorkspaceRoot, switchWorkspace } from "./workspace-service.js";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_MODEL = "openai-codex/gpt-5.4";
const MAIN_AGENT_ID = "main";
const SESSION_TTL_MS = 15 * 60_000;

// ── OpenAI OAuth constants ──────────────────────────────────────────────────
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPES = "openid profile email offline_access";

type JsonRecord = Record<string, unknown>;

type AuthProfileRecord = {
  type?: string;
  provider?: string;
  accountId?: string;
  label?: string;
  displayName?: string;
  email?: string;
  login?: string;
  refresh?: string;
  access?: string;
  expires?: number;
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
  authUrl?: string;
};

type StoredSession = ModelAuthLoginSession & {
  codeVerifier?: string;
  oauthState?: string;
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

// ── PKCE helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildAuthorizationUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: OPENAI_CLIENT_ID,
    response_type: "code",
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "pi",
  });
  return `${OPENAI_AUTH_URL}?${params.toString()}`;
}

// ── JWT helpers (parse without verification — we trust OpenAI's token endpoint) ─

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractOpenAiIdentity(accessToken: string): {
  accountId: string | null;
  email: string | null;
  displayName: string | null;
} {
  const payload = parseJwtPayload(accessToken);
  const authClaim = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return {
    accountId: (authClaim?.chatgpt_account_id as string) ?? null,
    email: (payload.email as string) ?? null,
    displayName: (payload.name as string) ?? null,
  };
}

// ── Token exchange ──────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_CLIENT_ID,
    code,
    redirect_uri: OPENAI_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

// ── Session management ──────────────────────────────────────────────────────

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
    authUrl: session.authUrl,
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

  const id = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const oauthState = randomBytes(16).toString("hex");
  const authUrl = buildAuthorizationUrl(codeChallenge, oauthState);

  const session: StoredSession = {
    id,
    provider: OPENAI_CODEX_PROVIDER,
    status: "running",
    output: `Open the link below to sign in with your OpenAI account.\n\nAfter signing in, your browser will redirect to a page that cannot be reached (localhost). This is expected.\nCopy the full URL from your browser's address bar and paste it below.\n`,
    startedAt: Date.now(),
    finishedAt: null,
    message: null,
    profiles: listProviderProfiles(OPENAI_CODEX_PROVIDER),
    authUrl,
    codeVerifier,
    oauthState,
  };

  sessions().set(id, session);
  return currentSessionSnapshot(session);
}

export async function submitOAuthCallback(
  sessionId: string,
  callbackUrl: string,
): Promise<ModelAuthLoginSession> {
  const session = sessions().get(sessionId);
  if (!session) {
    throw new Error("Login session not found.");
  }
  if (session.status !== "running") {
    throw new Error("Login session is not active.");
  }
  if (!session.codeVerifier || !session.oauthState) {
    throw new Error("Session is missing OAuth state.");
  }

  // Extract code and state from the callback URL
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("Invalid callback URL.");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    throw new Error("Authorization code not found in the callback URL.");
  }
  if (state !== session.oauthState) {
    throw new Error("OAuth state mismatch — please start a new login session.");
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, session.codeVerifier);
    const identity = extractOpenAiIdentity(tokens.access_token);

    // Build profile ID
    const profileId = `${OPENAI_CODEX_PROVIDER}:${identity.accountId ?? "default"}`;

    // Save to auth-profiles.json
    const raw = readAuthProfilesFile();
    const nextProfiles = { ...(raw.profiles ?? {}) };
    nextProfiles[profileId] = {
      type: "oauth",
      provider: OPENAI_CODEX_PROVIDER,
      accountId: identity.accountId ?? undefined,
      email: identity.email ?? undefined,
      displayName: identity.displayName ?? undefined,
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000,
    };

    let next: AuthProfilesFile = { ...raw, profiles: nextProfiles };
    next = writeCurrentProfileId(next, OPENAI_CODEX_PROVIDER, profileId);
    writeJsonFile(resolveAuthProfilesPath(), next);

    ensurePrimaryModel();

    // Update session
    session.status = "completed";
    session.finishedAt = Date.now();
    session.profiles = listProviderProfiles(OPENAI_CODEX_PROVIDER);
    session.message = `OpenAI account connected${identity.email ? ` (${identity.email})` : ""}.`;
    session.output += `\nSuccess! ${session.message}\n`;
    session.authUrl = undefined;
    session.codeVerifier = undefined;
    session.oauthState = undefined;

    return currentSessionSnapshot(session);
  } catch (error) {
    session.status = "failed";
    session.finishedAt = Date.now();
    session.profiles = listProviderProfiles(OPENAI_CODEX_PROVIDER);
    session.message = error instanceof Error ? error.message : "Token exchange failed.";
    session.output += `\nError: ${session.message}\n`;
    session.authUrl = undefined;
    session.codeVerifier = undefined;
    session.oauthState = undefined;

    return currentSessionSnapshot(session);
  }
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
