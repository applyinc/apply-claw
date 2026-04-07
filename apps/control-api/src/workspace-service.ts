import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { seedWorkspaceFromAssets } from "../../../src/cli/workspace-seed.js";

const UI_STATE_FILENAME = ".dench-ui-state.json";
const FIXED_STATE_DIRNAME = ".openclaw-dench";
const WORKSPACE_PREFIX = "workspace-";
const ROOT_WORKSPACE_DIRNAME = "workspace";
const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_WORKSPACE_NAME = "default";
const GATEWAY_MAIN_AGENT_ID = "main";
const CHAT_SLOT_PREFIX = "chat-slot-";
const RESERVED_WORKSPACE_NAMES = new Set([DEFAULT_WORKSPACE_NAME, GATEWAY_MAIN_AGENT_ID]);
const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;
const BOOTSTRAP_TEMPLATE_CONTENT = {
  "AGENTS.md": "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n",
  "SOUL.md": "# SOUL.md - Who You Are\n\nDescribe the personality and behavior of your agent here.\n",
  "TOOLS.md": "# TOOLS.md - Local Notes\n\nSkills define how tools work. This file is for your specifics.\n",
  "IDENTITY.md": "# IDENTITY.md - Who Am I?\n\nFill this in during your first conversation.\n",
  "USER.md": "# USER.md - About Your Human\n\nDescribe yourself and how you'd like the agent to interact with you.\n",
  "HEARTBEAT.md": "# HEARTBEAT.md\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
  "BOOTSTRAP.md": "# BOOTSTRAP.md - Hello, World\n\nYou just woke up. Time to figure out who you are.\n",
} as const;

export type WorkspaceGatewayMeta = {
  mode?: string;
  port?: number;
  url?: string;
};

export type WorkspaceSummary = {
  name: string;
  stateDir: string;
  workspaceDir: string | null;
  isActive: boolean;
  hasConfig: boolean;
  gateway: WorkspaceGatewayMeta | null;
};

type UIState = {
  activeWorkspace?: string | null;
};

type OpenClawConfig = {
  agents?: {
    defaults?: {
      workspace?: string;
      model?: {
        primary?: string;
      };
    };
    list?: Array<{
      id: string;
      default?: boolean;
      workspace?: string;
    }>;
  };
  gateway?: {
    mode?: unknown;
    port?: unknown;
  };
};

function resolveOpenClawHomeDir(): string {
  return process.env.OPENCLAW_HOME?.trim() || homedir();
}

export function resolveOpenClawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    || join(resolveOpenClawHomeDir(), FIXED_STATE_DIRNAME);
}

function normalizeWorkspaceName(name: string | null | undefined): string | null {
  const normalized = name?.trim() || null;
  if (!normalized) {
    return null;
  }
  if (!WORKSPACE_NAME_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

function workspaceDirName(workspaceName: string): string {
  return `${WORKSPACE_PREFIX}${workspaceName}`;
}

function workspaceNameFromDirName(dirName: string): string | null {
  if (dirName === ROOT_WORKSPACE_DIRNAME) {
    return DEFAULT_WORKSPACE_NAME;
  }
  if (!dirName.startsWith(WORKSPACE_PREFIX)) {
    return null;
  }
  return normalizeWorkspaceName(dirName.slice(WORKSPACE_PREFIX.length));
}

function isReservedWorkspaceName(name: string): boolean {
  const lowered = name.toLowerCase();
  return RESERVED_WORKSPACE_NAMES.has(lowered) || lowered.startsWith(CHAT_SLOT_PREFIX);
}

export function isValidWorkspaceName(name: string): boolean {
  const normalized = normalizeWorkspaceName(name);
  return normalized !== null && !isReservedWorkspaceName(normalized);
}

export function resolveWorkspaceDirForName(name: string): string {
  const normalized = normalizeWorkspaceName(name);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }
  return resolveWorkspaceDir(resolveOpenClawStateDir(), normalized);
}

function resolveWorkspaceDir(stateDir: string, workspaceName: string): string {
  if (workspaceName === DEFAULT_WORKSPACE_NAME) {
    const rootWorkspaceDir = join(stateDir, ROOT_WORKSPACE_DIRNAME);
    if (existsSync(rootWorkspaceDir)) {
      return rootWorkspaceDir;
    }
    const prefixedWorkspaceDir = join(stateDir, workspaceDirName(workspaceName));
    if (existsSync(prefixedWorkspaceDir)) {
      return prefixedWorkspaceDir;
    }
    return rootWorkspaceDir;
  }
  return join(stateDir, workspaceDirName(workspaceName));
}

function uiStatePath(stateDir: string): string {
  return join(stateDir, UI_STATE_FILENAME);
}

function readUIState(stateDir: string): UIState {
  try {
    return JSON.parse(readFileSync(uiStatePath(stateDir), "utf-8")) as UIState;
  } catch {
    return {};
  }
}

function writeUIState(stateDir: string, state: UIState): void {
  const path = uiStatePath(stateDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function scanWorkspaceNames(stateDir: string): string[] {
  try {
    const names = readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => workspaceNameFromDirName(entry.name))
      .filter((name): name is string => Boolean(name && name !== GATEWAY_MAIN_AGENT_ID));
    return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function getActiveWorkspaceNameForStateDir(stateDir: string): string | null {
  const envWorkspace = process.env.OPENCLAW_WORKSPACE?.trim();
  if (envWorkspace) {
    const rel = relative(resolve(stateDir), resolve(envWorkspace));
    if (!rel.startsWith("..")) {
      const top = rel.split(/[\\/]/)[0];
      const name = workspaceNameFromDirName(top);
      if (name) {
        return name;
      }
    }
  }

  const persisted = normalizeWorkspaceName(readUIState(stateDir).activeWorkspace);
  if (persisted) {
    return persisted;
  }

  return scanWorkspaceNames(stateDir)[0] ?? null;
}

export function resolveWorkspaceRoot(): string | null {
  const stateDir = resolveOpenClawStateDir();
  const activeWorkspace = getActiveWorkspaceNameForStateDir(stateDir);
  if (activeWorkspace) {
    const activeDir = resolveWorkspaceDir(stateDir, activeWorkspace);
    if (existsSync(activeDir)) {
      return activeDir;
    }
  }

  const fallback = scanWorkspaceNames(stateDir)[0] ?? null;
  if (!fallback) {
    return null;
  }
  const fallbackDir = resolveWorkspaceDir(stateDir, fallback);
  return existsSync(fallbackDir) ? fallbackDir : null;
}

export function getActiveWorkspaceName(): string | null {
  return getActiveWorkspaceNameForStateDir(resolveOpenClawStateDir());
}

function readOpenClawConfig(stateDir: string): OpenClawConfig {
  const configPath = join(stateDir, "openclaw.json");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as OpenClawConfig;
  } catch {
    return {};
  }
}

function writeOpenClawConfig(stateDir: string, config: OpenClawConfig): void {
  const configPath = join(stateDir, "openclaw.json");
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function readGatewayMeta(stateDir: string): WorkspaceGatewayMeta | null {
  const config = readOpenClawConfig(stateDir);
  const port = typeof config.gateway?.port === "number"
    ? config.gateway.port
    : typeof config.gateway?.port === "string"
      ? Number.parseInt(config.gateway.port, 10)
      : undefined;
  const mode = typeof config.gateway?.mode === "string" ? config.gateway.mode : undefined;
  return {
    ...(mode ? { mode } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
    ...(Number.isFinite(port) ? { url: `ws://127.0.0.1:${port}` } : {}),
  };
}

function workspaceNameToAgentId(workspaceName: string): string {
  return workspaceName === DEFAULT_WORKSPACE_NAME ? GATEWAY_MAIN_AGENT_ID : workspaceName;
}

function setDefaultAgentInConfig(stateDir: string, workspaceName: string): void {
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }

  const workspaceDir = resolveWorkspaceDir(stateDir, normalized);
  const config = readOpenClawConfig(stateDir);
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.list ??= [];

  if (normalized === DEFAULT_WORKSPACE_NAME) {
    config.agents.defaults.workspace = workspaceDir;
  }

  const agentId = workspaceNameToAgentId(normalized);
  const existing = config.agents.list.find((agent) => agent.id === agentId);
  if (existing) {
    existing.workspace = workspaceDir;
  } else {
    config.agents.list.push({
      id: agentId,
      workspace: workspaceDir,
    });
  }

  for (const agent of config.agents.list) {
    if (agent.id === agentId) {
      agent.default = true;
    } else if ("default" in agent) {
      delete agent.default;
    }
  }

  writeOpenClawConfig(stateDir, config);
}

export function listWorkspaces(): {
  activeWorkspace: string | null;
  workspaces: WorkspaceSummary[];
} {
  const stateDir = resolveOpenClawStateDir();
  const activeWorkspace = getActiveWorkspaceNameForStateDir(stateDir);
  const workspaces = scanWorkspaceNames(stateDir).map((workspaceName) => {
    const workspaceDir = resolveWorkspaceDir(stateDir, workspaceName);

    return {
      name: workspaceName,
      stateDir,
      workspaceDir: existsSync(workspaceDir) ? workspaceDir : null,
      isActive: workspaceName === activeWorkspace,
      hasConfig: existsSync(join(stateDir, "openclaw.json")),
      gateway: readGatewayMeta(stateDir),
    } satisfies WorkspaceSummary;
  });

  return {
    activeWorkspace: activeWorkspace ?? workspaces.find((workspace) => workspace.isActive)?.name ?? null,
    workspaces,
  };
}

export function getActiveModel() {
  const config = readOpenClawConfig(resolveOpenClawStateDir());
  return config.agents?.defaults?.model?.primary ?? null;
}

export function switchWorkspace(workspaceName: string) {
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name. Use letters, numbers, hyphens, or underscores.");
  }

  const { workspaces } = listWorkspaces();
  if (!workspaces.some((workspace) => workspace.name === normalized)) {
    throw new Error(`Workspace '${normalized}' was not found.`);
  }

  const stateDir = resolveOpenClawStateDir();
  writeUIState(stateDir, {
    ...readUIState(stateDir),
    activeWorkspace: normalized,
  });
  setDefaultAgentInConfig(stateDir, normalized);

  const next = listWorkspaces();
  const selected = next.workspaces.find((workspace) => workspace.name === normalized) ?? null;

  return {
    activeWorkspace: next.activeWorkspace,
    stateDir,
    workspace: selected,
    workspaceRoot: selected?.workspaceDir ?? null,
  };
}

export function createWorkspace(params: {
  workspaceName: string;
  seedBootstrap?: boolean;
}) {
  const workspaceName = params.workspaceName.trim();
  if (!workspaceName) {
    throw new Error("Workspace name is required.");
  }
  if (!WORKSPACE_NAME_RE.test(workspaceName) || !isValidWorkspaceName(workspaceName)) {
    throw new Error(
      "Invalid or reserved workspace name. Use letters, numbers, hyphens, or underscores. Reserved names include 'main', 'default', and 'chat-slot-*'.",
    );
  }

  const existing = listWorkspaces().workspaces;
  if (existing.some((workspace) => workspace.name.toLowerCase() === workspaceName.toLowerCase())) {
    throw new Error(`Workspace '${workspaceName}' already exists.`);
  }

  const stateDir = resolveOpenClawStateDir();
  const workspaceDir = resolveWorkspaceDirForName(workspaceName);
  const seedBootstrap = params.seedBootstrap !== false;
  const seededFiles: string[] = [];
  const copiedFiles: string[] = [];

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: false });

  if (seedBootstrap) {
    for (const filename of BOOTSTRAP_FILENAMES) {
      const filePath = join(workspaceDir, filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, BOOTSTRAP_TEMPLATE_CONTENT[filename], { encoding: "utf-8", flag: "wx" });
        seededFiles.push(filename);
      }
    }
  }

  const packageRoot = resolve(dirname(import.meta.dirname), "..", "..");
  const seedResult = seedWorkspaceFromAssets({ workspaceDir, packageRoot });
  seededFiles.push(...seedResult.projectionFiles);
  if (seedResult.seeded) {
    seededFiles.push("workspace.duckdb");
  }

  if (seedBootstrap) {
    const workspaceStateDir = join(workspaceDir, ".openclaw");
    const statePath = join(workspaceStateDir, "workspace-state.json");
    if (!existsSync(statePath)) {
      mkdirSync(workspaceStateDir, { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            version: 1,
            bootstrapSeededAt: new Date().toISOString(),
            duckdbSeededAt: existsSync(join(workspaceDir, "workspace.duckdb"))
              ? new Date().toISOString()
              : undefined,
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
    }
  }

  setDefaultAgentInConfig(stateDir, workspaceName);
  writeUIState(stateDir, {
    ...readUIState(stateDir),
    activeWorkspace: workspaceName,
  });

  return {
    workspace: workspaceName,
    activeWorkspace: workspaceName,
    workspaceDir,
    stateDir,
    copiedFiles,
    seededFiles,
    crmSynced: true,
    workspaceRoot: workspaceDir,
    profile: workspaceName,
    activeProfile: workspaceName,
  };
}

export function deleteWorkspace(workspaceName: string) {
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name. Use letters, numbers, hyphens, or underscores.");
  }

  const availableWorkspace = listWorkspaces().workspaces.find((candidate) => candidate.name === normalized);
  if (!availableWorkspace) {
    throw new Error(`Workspace '${normalized}' was not found.`);
  }
  if (!availableWorkspace.workspaceDir) {
    throw new Error(`Workspace '${normalized}' does not have a directory to delete.`);
  }

  rmSync(availableWorkspace.workspaceDir, { recursive: true, force: false });

  const remaining = listWorkspaces();
  if (remaining.activeWorkspace === normalized) {
    writeUIState(resolveOpenClawStateDir(), {
      ...readUIState(resolveOpenClawStateDir()),
      activeWorkspace: remaining.workspaces[0]?.name ?? null,
    });
  }

  const activeWorkspace = listWorkspaces().activeWorkspace;
  return {
    deleted: true,
    workspace: normalized,
    activeWorkspace,
    workspaceRoot: resolveWorkspaceRoot(),
    profile: normalized,
    activeProfile: activeWorkspace,
  };
}

export function resolveActiveAgentId(): string {
  const workspaceName = getActiveWorkspaceName() ?? DEFAULT_WORKSPACE_NAME;
  return workspaceNameToAgentId(workspaceName);
}

export function resolveAgentWorkspacePrefix(): string | null {
  const root = resolveWorkspaceRoot();
  if (!root) return null;
  if (root.startsWith("/")) {
    const cwd = process.cwd();
    const repoRoot = cwd.endsWith(join("apps", "control-api"))
      ? resolve(cwd, "..", "..")
      : cwd;
    const rel = relative(repoRoot, root);
    if (rel.startsWith("..")) return root;
    return rel || root;
  }
  return root;
}

export function resolveWebChatDir(): string {
  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot) {
    return join(workspaceRoot, ".openclaw", "web-chat");
  }

  const activeWorkspace = getActiveWorkspaceName();
  if (activeWorkspace) {
    const stateDir = resolveOpenClawStateDir();
    return join(resolveWorkspaceDir(stateDir, activeWorkspace), ".openclaw", "web-chat");
  }

  const stateDir = resolveOpenClawStateDir();
  return join(resolveWorkspaceDir(stateDir, DEFAULT_WORKSPACE_NAME), ".openclaw", "web-chat");
}
