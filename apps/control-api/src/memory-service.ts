import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenClawStateDir, resolveWorkspaceRoot } from "./workspace-service.js";

type MemoryFile = {
  name: string;
  path: string;
  sizeBytes: number;
};

export function getMemories() {
  const stateDir = resolveOpenClawStateDir();
  const workspaceDir = resolveWorkspaceRoot() ?? join(stateDir, "workspace");
  let mainMemory: string | null = null;
  const dailyLogs: MemoryFile[] = [];

  for (const filename of ["MEMORY.md", "memory.md"]) {
    const memPath = join(workspaceDir, filename);
    if (existsSync(memPath)) {
      try {
        mainMemory = readFileSync(memPath, "utf-8");
      } catch {
        // skip unreadable
      }
      break;
    }
  }

  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    try {
      const entries = readdirSync(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(memoryDir, entry.name);
        try {
          const content = readFileSync(filePath, "utf-8");
          dailyLogs.push({
            name: entry.name,
            path: filePath,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
          });
        } catch {
          // skip
        }
      }
    } catch {
      // dir unreadable
    }
  }

  dailyLogs.sort((a, b) => b.name.localeCompare(a.name));

  return { mainMemory, dailyLogs, workspaceDir };
}
