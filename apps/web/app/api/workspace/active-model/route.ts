import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const stateDir = resolveOpenClawStateDir();
  const configPath = join(stateDir, "openclaw.json");

  if (!existsSync(configPath)) {
    return Response.json({ model: null });
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const primary = raw?.agents?.defaults?.model?.primary;
    return Response.json({ model: typeof primary === "string" ? primary : null });
  } catch {
    return Response.json({ model: null });
  }
}
