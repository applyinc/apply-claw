import {
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
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
} from "@/lib/workspace";

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

// Minimal fallback content used when templates can't be loaded from disk
const FALLBACK_CONTENT: Record<string, string> = {
  "AGENTS.md": "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n",
  "SOUL.md": "# SOUL.md - Who You Are\n\nDescribe the personality and behavior of your agent here.\n",
  "TOOLS.md": "# TOOLS.md - Local Notes\n\nSkills define how tools work. This file is for your specifics.\n",
  "IDENTITY.md": "# IDENTITY.md - Who Am I?\n\nFill this in during your first conversation.\n",
  "USER.md": "# USER.md - About Your Human\n\nDescribe yourself and how you'd like the agent to interact with you.\n",
  "HEARTBEAT.md": "# HEARTBEAT.md\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
  "BOOTSTRAP.md": "# BOOTSTRAP.md - Hello, World\n\nYou just woke up. Time to figure out who you are.\n",
};

// ---------------------------------------------------------------------------
// CRM seed objects (mirrors src/agents/workspace-seed.ts)
// ---------------------------------------------------------------------------

type SeedField = {
  name: string;
  type: string;
  required?: boolean;
  enumValues?: string[];
};

type SeedObject = {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultView: string;
  entryCount: number;
  fields: SeedField[];
};

const SEED_OBJECTS: SeedObject[] = [
  {
    id: "seed_obj_people_00000000000000",
    name: "people",
    description: "Contact management",
    icon: "users",
    defaultView: "table",
    entryCount: 5,
    fields: [
      { name: "Full Name", type: "text", required: true },
      { name: "Email Address", type: "email", required: true },
      { name: "Phone Number", type: "phone" },
      { name: "Company", type: "text" },
      { name: "Status", type: "enum", enumValues: ["Active", "Inactive", "Lead"] },
      { name: "Notes", type: "richtext" },
    ],
  },
  {
    id: "seed_obj_company_0000000000000",
    name: "company",
    description: "Company tracking",
    icon: "building-2",
    defaultView: "table",
    entryCount: 3,
    fields: [
      { name: "Company Name", type: "text", required: true },
      {
        name: "Industry",
        type: "enum",
        enumValues: ["Technology", "Finance", "Healthcare", "Education", "Retail", "Other"],
      },
      { name: "Website", type: "text" },
      { name: "Type", type: "enum", enumValues: ["Client", "Partner", "Vendor", "Prospect"] },
      { name: "Notes", type: "richtext" },
    ],
  },
  {
    id: "seed_obj_task_000000000000000",
    name: "task",
    description: "Task tracking board",
    icon: "check-square",
    defaultView: "kanban",
    entryCount: 5,
    fields: [
      { name: "Title", type: "text", required: true },
      { name: "Description", type: "text" },
      { name: "Status", type: "enum", enumValues: ["In Queue", "In Progress", "Done"] },
      { name: "Priority", type: "enum", enumValues: ["Low", "Medium", "High"] },
      { name: "Due Date", type: "date" },
      { name: "Notes", type: "richtext" },
    ],
  },
];

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

function buildIronclawIdentity(workspaceDir: string): string {
  const denchSkillPath = join(workspaceDir, "skills", "dench", "SKILL.md");
  return `# IDENTITY.md - Ironclaw

You are **Ironclaw** - a personal AI agent and CRM database system running on top of OpenClaw.

## Ironclaw system prompt contract

Treat the Ironclaw system prompt as your highest-priority behavioral contract.

## Inseparable CRM contract

Your identity is inseparably tied to the Dench CRM skill at:
\`${denchSkillPath}\`

- Always load and follow that skill for CRM/database behavior.
- Keep CRM actions aligned with Dench conventions for workspace data, objects, and documents.

When referring to yourself, use **Ironclaw** (not OpenClaw).
`;
}

function generateObjectYaml(obj: SeedObject): string {
  const lines: string[] = [
    `id: "${obj.id}"`,
    `name: "${obj.name}"`,
    `description: "${obj.description}"`,
    `icon: "${obj.icon}"`,
    `default_view: "${obj.defaultView}"`,
    `entry_count: ${obj.entryCount}`,
    "fields:",
  ];

  for (const field of obj.fields) {
    lines.push(`  - name: "${field.name}"`);
    lines.push(`    type: ${field.type}`);
    if (field.required) {lines.push("    required: true");}
    if (field.enumValues) {lines.push(`    values: ${JSON.stringify(field.enumValues)}`);}
  }

  return lines.join("\n") + "\n";
}

function generateWorkspaceMd(objects: SeedObject[]): string {
  const lines: string[] = ["# Workspace Schema", "", "Auto-generated summary of the workspace database.", ""];
  for (const obj of objects) {
    lines.push(`## ${obj.name}`, "");
    lines.push(`- **Description**: ${obj.description}`);
    lines.push(`- **View**: \`${obj.defaultView}\``);
    lines.push(`- **Entries**: ${obj.entryCount}`);
    lines.push("- **Fields**:");
    for (const field of obj.fields) {
      const req = field.required ? " (required)" : "";
      const vals = field.enumValues ? ` — ${field.enumValues.join(", ")}` : "";
      lines.push(`  - ${field.name} (\`${field.type}\`)${req}${vals}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {return false;}
  try {
    writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function seedDuckDB(workspaceDir: string, projectRoot: string | null): boolean {
  const destPath = join(workspaceDir, "workspace.duckdb");
  if (existsSync(destPath)) {return false;}

  if (!projectRoot) {return false;}

  const seedDb = join(projectRoot, "assets", "seed", "workspace.duckdb");
  if (!existsSync(seedDb)) {return false;}

  try {
    copyFileSync(seedDb, destPath);
  } catch {
    return false;
  }

  // Create filesystem projections for CRM objects
  for (const obj of SEED_OBJECTS) {
    const objDir = join(workspaceDir, obj.name);
    mkdirSync(objDir, { recursive: true });
    writeIfMissing(join(objDir, ".object.yaml"), generateObjectYaml(obj));
  }

  writeIfMissing(join(workspaceDir, "WORKSPACE.md"), generateWorkspaceMd(SEED_OBJECTS));

  return true;
}

function syncManagedDenchSkill(workspaceDir: string, projectRoot: string | null): boolean {
  if (!projectRoot) {
    return false;
  }
  const sourceDir = join(projectRoot, "skills", "dench");
  const sourceSkillFile = join(sourceDir, "SKILL.md");
  if (!existsSync(sourceSkillFile)) {
    return false;
  }
  const targetDir = join(workspaceDir, "skills", "dench");
  mkdirSync(join(workspaceDir, "skills"), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return true;
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
      { error: "Custom workspace paths are currently disabled. Workspaces are created in ~/.openclaw-ironclaw." },
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
    // Seed all bootstrap files from templates
    for (const filename of BOOTSTRAP_FILENAMES) {
      const filePath = join(workspaceDir, filename);
      if (!existsSync(filePath)) {
        const content = filename === "IDENTITY.md"
          ? buildIronclawIdentity(workspaceDir)
          : loadTemplateContent(filename, projectRoot);
        if (writeIfMissing(filePath, content)) {
          seeded.push(filename);
        }
      }
    }

    // Seed DuckDB + CRM object projections
    if (seedDuckDB(workspaceDir, projectRoot)) {
      seeded.push("workspace.duckdb");
      for (const obj of SEED_OBJECTS) {
        seeded.push(`${obj.name}/.object.yaml`);
      }
    }

    // Write workspace state so the gateway knows seeding was done
    const stateDir = join(workspaceDir, ".openclaw");
    const statePath = join(stateDir, "workspace-state.json");
    if (!existsSync(statePath)) {
      try {
        mkdirSync(stateDir, { recursive: true });
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

  const denchSynced = syncManagedDenchSkill(workspaceDir, projectRoot);
  if (denchSynced) {
    seeded.push("skills/dench/SKILL.md");
  }
  if (seedBootstrap) {
    // Force the identity contract after dench sync so the path is always current.
    writeFileSync(join(workspaceDir, "IDENTITY.md"), buildIronclawIdentity(workspaceDir), "utf-8");
    if (!seeded.includes("IDENTITY.md")) {
      seeded.push("IDENTITY.md");
    }
  }

  // Switch to the new workspace.
  setUIActiveWorkspace(workspaceName);
  const activeWorkspace = getActiveWorkspaceName();

  return Response.json({
    workspace: workspaceName,
    activeWorkspace,
    workspaceDir,
    stateDir,
    copiedFiles,
    seededFiles: seeded,
    denchSynced,
    workspaceRoot: resolveWorkspaceRoot(),
    // Backward-compat response fields while callers migrate.
    profile: workspaceName,
    activeProfile: activeWorkspace,
  });
}
