import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SeedField = {
  name: string;
  type: string;
  required?: boolean;
  enumValues?: string[];
};

export type SeedObject = {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultView: string;
  entryCount: number;
  fields: SeedField[];
};

export type WorkspaceSeedResultReason =
  | "seeded"
  | "already-exists"
  | "seed-asset-missing"
  | "copy-failed";

export type WorkspaceSeedResult = {
  workspaceDir: string;
  dbPath: string;
  seedDbPath: string;
  seeded: boolean;
  reason: WorkspaceSeedResultReason;
  projectionFiles: string[];
  error?: string;
};

export const SEED_OBJECTS: SeedObject[] = [
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

export function buildDenchClawIdentity(workspaceDir: string): string {
  const crmSkillPath = path.join(workspaceDir, "skills", "crm", "SKILL.md");
  const browserSkillPath = path.join(workspaceDir, "skills", "browser", "SKILL.md");
  return `# IDENTITY.md - DenchClaw

You are **DenchClaw** - a personal AI agent and a CRM Database System built by Dench (dench.com), running on top of [OpenClaw](https://github.com/openclaw/openclaw).

## DenchClaw system prompt contract

Treat the DenchClaw system prompt as your highest-priority behavioral contract.

## Inseparable CRM contract

Your identity is inextricably tied to the CRM skill at:
\`${crmSkillPath}\`

- Always load and follow that skill for CRM/database behavior.
- Treat the CRM skill as always-on system context.
- Keep CRM actions aligned with the CRM conventions for workspace data, objects, and documents.

## Browser automation contract

Your browser automation behavior is defined by the Browser skill at:
\`${browserSkillPath}\`

- Always load and follow that skill for browser-based tasks.
- Treat the Browser skill as always-on system context.

## What you do

- Find and enrich leads, maintain CRM pipelines, and help run outreach workflows.
- Chat with local DuckDB workspace data and return structured insights.
- Generate analytics and maintain workspace documentation.

## Links

- Website: https://denchclaw.sh
- GitHub: https://github.com/DenchHQ/denchclaw
- Skills Store: https://skills.sh

When referring to yourself, use **DenchClaw** (not OpenClaw).`;
}

export function generateObjectYaml(obj: SeedObject): string {
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
    if (field.required) {
      lines.push("    required: true");
    }
    if (field.enumValues) {
      lines.push(`    values: ${JSON.stringify(field.enumValues)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function generateWorkspaceMd(objects: SeedObject[]): string {
  const lines: string[] = [
    "# Workspace Schema",
    "",
    "Auto-generated summary of the workspace database.",
    "",
  ];
  for (const obj of objects) {
    lines.push(`## ${obj.name}`);
    lines.push("");
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

export function seedDenchClawIdentity(workspaceDir: string): void {
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  writeFileSync(identityPath, `${buildDenchClawIdentity(workspaceDir)}\n`, "utf-8");
}

export const MANAGED_SKILLS: ReadonlyArray<{ name: string; templatePaths?: boolean }> = [
  { name: "crm", templatePaths: true },
  { name: "browser" },
];

export function seedSkill(
  params: { workspaceDir: string; packageRoot: string },
  skill: { name: string; templatePaths?: boolean },
): void {
  const sourceDir = path.join(params.packageRoot, "skills", skill.name);
  const sourceSkillFile = path.join(sourceDir, "SKILL.md");
  if (!existsSync(sourceSkillFile)) {
    return;
  }
  const targetDir = path.join(params.workspaceDir, "skills", skill.name);
  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });

  if (skill.templatePaths) {
    const targetSkillFile = path.join(targetDir, "SKILL.md");
    const content = readFileSync(targetSkillFile, "utf-8");
    writeFileSync(
      targetSkillFile,
      content.replaceAll("{{WORKSPACE_PATH}}", params.workspaceDir),
      "utf-8",
    );
  }
}

export function writeIfMissing(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    return false;
  }
  try {
    writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function seedWorkspaceFromAssets(params: {
  workspaceDir: string;
  packageRoot: string;
}): WorkspaceSeedResult {
  const workspaceDir = path.resolve(params.workspaceDir);
  const dbPath = path.join(workspaceDir, "workspace.duckdb");
  const seedDbPath = path.join(params.packageRoot, "assets", "seed", "workspace.duckdb");
  const projectionFiles = [
    "people/.object.yaml",
    "company/.object.yaml",
    "task/.object.yaml",
    "WORKSPACE.md",
    "IDENTITY.md",
    ...MANAGED_SKILLS.map((s) => `skills/${s.name}/SKILL.md`),
  ];

  mkdirSync(workspaceDir, { recursive: true });
  for (const skill of MANAGED_SKILLS) {
    seedSkill({ workspaceDir, packageRoot: params.packageRoot }, skill);
  }
  seedDenchClawIdentity(workspaceDir);

  if (existsSync(dbPath)) {
    return {
      workspaceDir,
      dbPath,
      seedDbPath,
      seeded: false,
      reason: "already-exists",
      projectionFiles: [],
    };
  }

  if (!existsSync(seedDbPath)) {
    return {
      workspaceDir,
      dbPath,
      seedDbPath,
      seeded: false,
      reason: "seed-asset-missing",
      projectionFiles: [],
    };
  }

  try {
    copyFileSync(seedDbPath, dbPath);
  } catch (error) {
    return {
      workspaceDir,
      dbPath,
      seedDbPath,
      seeded: false,
      reason: "copy-failed",
      projectionFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (const obj of SEED_OBJECTS) {
    const objDir = path.join(workspaceDir, obj.name);
    mkdirSync(objDir, { recursive: true });
    writeFileSync(path.join(objDir, ".object.yaml"), generateObjectYaml(obj), "utf-8");
  }
  writeIfMissing(path.join(workspaceDir, "WORKSPACE.md"), generateWorkspaceMd(SEED_OBJECTS));

  return {
    workspaceDir,
    dbPath,
    seedDbPath,
    seeded: true,
    reason: "seeded",
    projectionFiles,
  };
}
