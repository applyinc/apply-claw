import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  discoverWorkspaces,
  setUIActiveWorkspace,
  getActiveWorkspaceName,
  resolveOpenClawStateDir,
  resolveWorkspaceDirForName,
  isValidWorkspaceName,
  resolveWorkspaceRoot,
  ensureAgentInConfig,
} from "@/lib/workspace";
import {
  seedWorkspaceFromAssets,
  buildDenchClawIdentity,
} from "@repo/cli/workspace-seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Bootstrap file names (must match src/agents/workspace.ts)
// ---------------------------------------------------------------------------

const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

const FALLBACK_CONTENT: Record<string, string> = {
  "AGENTS.md": "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n",
  "SOUL.md": "# SOUL.md - Who You Are\n\nDescribe the personality and behavior of your agent here.\n",
  "TOOLS.md": "# TOOLS.md - Local Notes\n\nSkills define how tools work. This file is for your specifics.\n",
  "IDENTITY.md": "# IDENTITY.md - Who Am I?\n\nFill this in during your first conversation.\n",
  "USER.md": "# USER.md - About Your Human\n\nDescribe yourself and how you'd like the agent to interact with you.\n",
  "HEARTBEAT.md": "# HEARTBEAT.md\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
  "BOOTSTRAP.md": "# BOOTSTRAP.md - Hello, World\n\nYou just woke up. Time to figure out who you are.\n",
};

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {return content;}
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {return content;}
  return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
}

/** Try multiple candidate paths to find the monorepo root. */
function resolveProjectRoot(): string | null {
  const marker = join("docs", "reference", "templates", "AGENTS.md");
  const cwd = process.cwd();

  // CWD is the repo root (standalone builds)
  if (existsSync(join(cwd, marker))) {return cwd;}

  // CWD is apps/web/ (dev mode)
  const fromApps = resolve(cwd, "..", "..");
  if (existsSync(join(fromApps, marker))) {return fromApps;}

  return null;
}

function loadTemplateContent(filename: string, projectRoot: string | null): string {
  if (projectRoot) {
    const templatePath = join(projectRoot, "docs", "reference", "templates", filename);
    try {
      const raw = readFileSync(templatePath, "utf-8");
      return stripFrontMatter(raw);
    } catch {
      // fall through to fallback
    }
  }
  return FALLBACK_CONTENT[filename] ?? "";
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    workspace?: string;
    profile?: string;
    path?: string;
    seedBootstrap?: boolean;
  };
  const workspaceName = (body.workspace ?? body.profile)?.trim() || "";
  if (!workspaceName) {
    return Response.json(
      { error: "Workspace name is required." },
      { status: 400 },
    );
  }
  if (body.path?.trim()) {
    return Response.json(
      { error: "Custom workspace paths are currently disabled. Workspaces are created in ~/.openclaw-dench." },
      { status: 400 },
    );
  }
  if (!WORKSPACE_NAME_RE.test(workspaceName) || !isValidWorkspaceName(workspaceName)) {
    return Response.json(
      { error: "Invalid workspace name. Use letters, numbers, hyphens, or underscores." },
      { status: 400 },
    );
  }

  const existingWorkspaces = discoverWorkspaces();
  if (existingWorkspaces.some((workspace) => workspace.name.toLowerCase() === workspaceName.toLowerCase())) {
    return Response.json(
      { error: `Workspace '${workspaceName}' already exists.` },
      { status: 409 },
    );
  }

  const stateDir = resolveOpenClawStateDir();
  const workspaceDir = resolveWorkspaceDirForName(workspaceName);
  const seedBootstrap = body.seedBootstrap !== false;
  const seeded: string[] = [];
  const copiedFiles: string[] = [];

  const projectRoot = resolveProjectRoot();

  try {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: false });
  } catch (err) {
    return Response.json(
      { error: `Failed to prepare workspace directory: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  if (seedBootstrap) {
    // Seed bootstrap files from templates (IDENTITY.md is handled by
    // seedWorkspaceFromAssets below, so skip it in this loop).
    for (const filename of BOOTSTRAP_FILENAMES) {
      if (filename === "IDENTITY.md") {continue;}
      const filePath = join(workspaceDir, filename);
      if (!existsSync(filePath)) {
        const content = loadTemplateContent(filename, projectRoot);
        try {
          writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
          seeded.push(filename);
        } catch {
          // race / already exists
        }
      }
    }
  }

  // Seed managed skills, DenchClaw identity, DuckDB, and CRM object projections.
  // This is the single source of truth shared with the CLI bootstrap path.
  if (projectRoot) {
    const seedResult = seedWorkspaceFromAssets({ workspaceDir, packageRoot: projectRoot });
    seeded.push(...seedResult.projectionFiles);
    if (seedResult.seeded) {
      seeded.push("workspace.duckdb");
    }
  } else {
    // No project root available (e.g. standalone/production build without
    // the repo tree). Still write the DenchClaw identity so the agent has
    // a usable IDENTITY.md.
    const identityPath = join(workspaceDir, "IDENTITY.md");
    writeFileSync(identityPath, buildDenchClawIdentity(workspaceDir) + "\n", "utf-8");
    seeded.push("IDENTITY.md");
  }

  if (seedBootstrap) {
    // Write workspace state so the gateway knows seeding was done.
    const wsStateDir = join(workspaceDir, ".openclaw");
    const statePath = join(wsStateDir, "workspace-state.json");
    if (!existsSync(statePath)) {
      try {
        mkdirSync(wsStateDir, { recursive: true });
        const state = {
          version: 1,
          bootstrapSeededAt: new Date().toISOString(),
          duckdbSeededAt: existsSync(join(workspaceDir, "workspace.duckdb"))
            ? new Date().toISOString()
            : undefined,
        };
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      } catch {
        // Best-effort state tracking
      }
    }
  }

  // Register a per-workspace agent in openclaw.json and make it the default.
  ensureAgentInConfig(workspaceName, workspaceDir);

  // Switch the UI to the new workspace.
  setUIActiveWorkspace(workspaceName);
  const activeWorkspace = getActiveWorkspaceName();

  return Response.json({
    workspace: workspaceName,
    activeWorkspace,
    workspaceDir,
    stateDir,
    copiedFiles,
    seededFiles: seeded,
    crmSynced: !!projectRoot,
    workspaceRoot: resolveWorkspaceRoot(),
    // Backward-compat response fields while callers migrate.
    profile: workspaceName,
    activeProfile: activeWorkspace,
  });
}
