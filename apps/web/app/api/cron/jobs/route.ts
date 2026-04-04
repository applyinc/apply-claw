import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const CRON_DIR = join(resolveOpenClawStateDir(), "cron");
const JOBS_FILE = join(CRON_DIR, "jobs.json");

type CronStoreFile = {
  version: 1;
  jobs: Array<Record<string, unknown>>;
};

/** Read cron jobs.json, returning empty array if missing or invalid. */
function readJobsFile(): Array<Record<string, unknown>> {
  if (!existsSync(JOBS_FILE)) {return [];}
  try {
    const raw = readFileSync(JOBS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as CronStoreFile;
    if (parsed && Array.isArray(parsed.jobs)) {return parsed.jobs;}
    return [];
  } catch {
    return [];
  }
}

/** Write jobs back to jobs.json. */
function writeJobsFile(jobs: Array<Record<string, unknown>>): void {
  if (!existsSync(CRON_DIR)) {
    mkdirSync(CRON_DIR, { recursive: true });
  }
  const store: CronStoreFile = { version: 1, jobs };
  writeFileSync(JOBS_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/** Compute next wake time from job states (minimum nextRunAtMs among enabled jobs). */
function computeNextWakeAtMs(jobs: Array<Record<string, unknown>>): number | null {
  let min: number | null = null;
  for (const job of jobs) {
    if (job.enabled !== true) {continue;}
    const state = job.state as Record<string, unknown> | undefined;
    if (!state) {continue;}
    const next = state.nextRunAtMs;
    if (typeof next === "number" && Number.isFinite(next)) {
      if (min === null || next < min) {min = next;}
    }
  }
  return min;
}

/** Read heartbeat config from ~/.openclaw/config.yaml (best-effort). */
function readHeartbeatInfo(): { intervalMs: number; nextDueEstimateMs: number | null } {
  const defaults = { intervalMs: 30 * 60_000, nextDueEstimateMs: null as number | null };

  // Try to read agent session stores to estimate next heartbeat from lastRunMs
  try {
    const agentsDir = join(resolveOpenClawStateDir(), "agents");
    if (!existsSync(agentsDir)) {return defaults;}

    const agentDirs = readdirSync(agentsDir, { withFileTypes: true });
    let latestHeartbeat: number | null = null;

    for (const d of agentDirs) {
      if (!d.isDirectory()) {continue;}
      const storePath = join(agentsDir, d.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) {continue;}
      try {
        const raw = readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, { updatedAt?: number }>;
        // Look for the main agent session (shortest key, most recently updated)
        for (const [key, entry] of Object.entries(store)) {
          if (key.startsWith("agent:") && !key.includes(":cron:") && entry.updatedAt) {
            if (latestHeartbeat === null || entry.updatedAt > latestHeartbeat) {
              latestHeartbeat = entry.updatedAt;
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (latestHeartbeat) {
      defaults.nextDueEstimateMs = latestHeartbeat + defaults.intervalMs;
    }
  } catch {
    // ignore
  }

  return defaults;
}

/** GET /api/cron/jobs -- list all cron jobs with heartbeat & status info */
export async function GET() {
  const jobs = readJobsFile();
  const heartbeat = readHeartbeatInfo();
  const nextWakeAtMs = computeNextWakeAtMs(jobs);

  return Response.json({
    jobs,
    heartbeat,
    cronStatus: {
      enabled: jobs.length > 0,
      nextWakeAtMs,
    },
  });
}

/** POST /api/cron/jobs -- create a new cron job */
export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const now = Date.now();
    const job: Record<string, unknown> = {
      id: randomUUID(),
      name: body.name ?? "Untitled Job",
      description: body.description ?? "",
      enabled: body.enabled ?? true,
      deleteAfterRun: body.deleteAfterRun ?? false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: body.schedule ?? { kind: "every", everyMs: 3600000 },
      sessionTarget: body.sessionTarget ?? "isolated",
      wakeMode: body.wakeMode ?? "next-heartbeat",
      payload: body.payload ?? { kind: "agentTurn", message: "" },
      delivery: body.delivery,
      state: {},
    };
    const jobs = readJobsFile();
    jobs.push(job);
    writeJobsFile(jobs);
    return Response.json(job, { status: 201 });
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

/** PUT /api/cron/jobs -- update an existing cron job (requires { id, ...fields }) */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = body.id;
    if (typeof id !== "string") {
      return Response.json({ error: "Missing job id" }, { status: 400 });
    }
    const jobs = readJobsFile();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    const existing = jobs[idx];
    const updated: Record<string, unknown> = { ...existing, ...body, updatedAtMs: Date.now() };
    // Preserve fields that shouldn't be overwritten
    updated.id = existing.id;
    updated.createdAtMs = existing.createdAtMs;
    jobs[idx] = updated;
    writeJobsFile(jobs);
    return Response.json(updated);
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

/** DELETE /api/cron/jobs -- delete a cron job (requires { id } in body) */
export async function DELETE(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = body.id;
    if (typeof id !== "string") {
      return Response.json({ error: "Missing job id" }, { status: 400 });
    }
    const jobs = readJobsFile();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    jobs.splice(idx, 1);
    writeJobsFile(jobs);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
