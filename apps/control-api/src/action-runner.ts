import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { extname, join } from "node:path";

export type ActionConfig = {
  id: string;
  label: string;
  icon?: string;
  variant?: "default" | "primary" | "destructive" | "success" | "warning";
  script?: string;
  scriptPath?: string;
  runtime?: "auto" | "inline" | "node" | "python" | "bash" | "ruby";
  confirmMessage?: string;
  loadingLabel?: string;
  successLabel?: string;
  errorLabel?: string;
  autoResetMs?: number;
  timeout?: number;
};

export type ActionEvent =
  | { type: "started"; entryId: string; runId: string }
  | { type: "progress"; entryId: string; percent: number; message?: string }
  | { type: "log"; entryId: string; level: string; message: string }
  | { type: "completed"; entryId: string; status: "success" | "error"; result?: unknown; error?: string; exitCode?: number }
  | { type: "done" };

export type ActionContext = {
  entryId: string;
  entryData: Record<string, unknown>;
  objectName: string;
  objectId: string;
  actionId: string;
  fieldId: string;
  workspacePath: string;
  dbPath: string;
  apiUrl: string;
};

const MAX_CONCURRENT = 8;
const RUNTIME_MAP: Record<string, { command: string; args: (file: string) => string[] }> = {
  ".js": { command: "node", args: (file) => [file] },
  ".mjs": { command: "node", args: (file) => [file] },
  ".cjs": { command: "node", args: (file) => [file] },
  ".ts": { command: "npx", args: (file) => ["tsx", file] },
  ".py": { command: "python3", args: (file) => [file] },
  ".sh": { command: "bash", args: (file) => [file] },
  ".rb": { command: "ruby", args: (file) => [file] },
  ".php": { command: "php", args: (file) => [file] },
};

export function resolveRuntime(
  scriptPath: string,
  explicitRuntime?: string,
): { command: string; args: string[] } {
  if (explicitRuntime && explicitRuntime !== "auto") {
    const runtimeCommands: Record<string, string> = {
      bash: "bash",
      node: "node",
      python: "python3",
      ruby: "ruby",
    };
    const command = runtimeCommands[explicitRuntime] ?? explicitRuntime;
    return { command, args: [scriptPath] };
  }

  const runtime = RUNTIME_MAP[extname(scriptPath).toLowerCase()];
  if (runtime) {
    return { command: runtime.command, args: runtime.args(scriptPath) };
  }

  return { command: scriptPath, args: [] };
}

export function buildEnv(ctx: ActionContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DENCH_ACTION_ID: ctx.actionId,
    DENCH_API_URL: ctx.apiUrl,
    DENCH_DB_PATH: ctx.dbPath,
    DENCH_ENTRY_DATA: JSON.stringify(ctx.entryData),
    DENCH_ENTRY_ID: ctx.entryId,
    DENCH_FIELD_ID: ctx.fieldId,
    DENCH_OBJECT_ID: ctx.objectId,
    DENCH_OBJECT_NAME: ctx.objectName,
    DENCH_WORKSPACE_PATH: ctx.workspacePath,
  };
}

function generateInlineWrapper(script: string): string {
  return `
const dench = {
  context: {
    entryId: process.env.DENCH_ENTRY_ID,
    entryData: JSON.parse(process.env.DENCH_ENTRY_DATA || '{}'),
    objectName: process.env.DENCH_OBJECT_NAME,
    objectId: process.env.DENCH_OBJECT_ID,
    actionId: process.env.DENCH_ACTION_ID,
    fieldId: process.env.DENCH_FIELD_ID,
    workspacePath: process.env.DENCH_WORKSPACE_PATH,
    dbPath: process.env.DENCH_DB_PATH,
    apiUrl: process.env.DENCH_API_URL,
  },
  log(level, message) {
    console.log(JSON.stringify({ type: "log", level, message }));
  },
  progress(percent, message) {
    console.log(JSON.stringify({ type: "progress", percent, message }));
  },
};

(async () => {
${script}
})().then((result) => {
  console.log(JSON.stringify({ type: "result", status: "success", data: result ?? {} }));
}).catch((error) => {
  console.log(JSON.stringify({
    type: "result",
    status: "error",
    data: { message: error?.message || String(error) },
  }));
  process.exit(1);
});
`;
}

export async function* runActionScript(
  action: ActionConfig,
  ctx: ActionContext,
  runId: string,
): AsyncGenerator<ActionEvent> {
  yield { type: "started", entryId: ctx.entryId, runId };

  const timeout = action.timeout ?? 60_000;
  const env = buildEnv(ctx);
  let child: ChildProcess;
  let tmpFile: string | null = null;

  try {
    if (action.script && (!action.scriptPath || action.runtime === "inline")) {
      const tmpDir = join(ctx.workspacePath, ".actions", ".tmp");
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true });
      }
      tmpFile = join(tmpDir, `${runId}.js`);
      writeFileSync(tmpFile, generateInlineWrapper(action.script), "utf-8");
      child = spawn("node", [tmpFile], {
        cwd: ctx.workspacePath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else if (action.scriptPath) {
      const objectDir = join(ctx.workspacePath, ctx.objectName);
      const fullPath = join(objectDir, action.scriptPath);
      if (!existsSync(fullPath)) {
        yield { type: "completed", entryId: ctx.entryId, status: "error", error: `Script not found: ${action.scriptPath}` };
        return;
      }
      const { command, args } = resolveRuntime(fullPath, action.runtime);
      child = spawn(command, args, {
        cwd: objectDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      yield { type: "completed", entryId: ctx.entryId, status: "error", error: "No script or scriptPath defined" };
      return;
    }
  } catch (error) {
    yield {
      type: "completed",
      entryId: ctx.entryId,
      status: "error",
      error: `Failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
    };
    if (tmpFile) {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
    return;
  }

  const stderrChunks: string[] = [];
  let gotResult = false;
  let done = false;
  let resolveWait: (() => void) | null = null;
  const eventQueue: ActionEvent[] = [];

  function pushEvent(event: ActionEvent) {
    eventQueue.push(event);
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 5_000);
  }, timeout);

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "progress") {
        pushEvent({
          type: "progress",
          entryId: ctx.entryId,
          percent: Number(parsed.percent ?? 0),
          message: typeof parsed.message === "string" ? parsed.message : undefined,
        });
        return;
      }
      if (parsed.type === "log") {
        pushEvent({
          type: "log",
          entryId: ctx.entryId,
          level: typeof parsed.level === "string" ? parsed.level : "info",
          message: typeof parsed.message === "string" ? parsed.message : "",
        });
        return;
      }
      if (parsed.type === "result") {
        gotResult = true;
        pushEvent({
          type: "completed",
          entryId: ctx.entryId,
          status: parsed.status === "error" ? "error" : "success",
          result: parsed.data,
          error: parsed.status === "error" && typeof parsed.data === "object" && parsed.data && "message" in parsed.data
            ? String((parsed.data as { message?: unknown }).message ?? "Script error")
            : undefined,
        });
        return;
      }
    } catch {}
    pushEvent({ type: "log", entryId: ctx.entryId, level: "info", message: line });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (!gotResult) {
      const stderr = stderrChunks.join("").trim();
      pushEvent({
        type: "completed",
        entryId: ctx.entryId,
        status: code === 0 ? "success" : "error",
        result: code === 0 ? {} : undefined,
        error: code === 0 ? undefined : stderr || `Process exited with code ${code}`,
        exitCode: code ?? undefined,
      });
    }
    done = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    if (!gotResult) {
      pushEvent({
        type: "completed",
        entryId: ctx.entryId,
        status: "error",
        error: `Process error: ${error.message}`,
      });
    }
    done = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  try {
    while (!done || eventQueue.length > 0) {
      if (eventQueue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
    }
  } finally {
    if (tmpFile) {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
  }
}

export async function* runBulkAction(
  action: ActionConfig,
  contexts: ActionContext[],
  runIdPrefix: string,
): AsyncGenerator<ActionEvent> {
  let running = 0;
  let nextIndex = 0;
  const pending: Array<{ gen: AsyncGenerator<ActionEvent>; promise: Promise<IteratorResult<ActionEvent>> | null }> = [];

  function startNext() {
    if (nextIndex >= contexts.length) {
      return;
    }
    const context = contexts[nextIndex];
    const generator = runActionScript(action, context, `${runIdPrefix}_${nextIndex}`);
    nextIndex += 1;
    running += 1;
    pending.push({ gen: generator, promise: generator.next() });
  }

  while (running < MAX_CONCURRENT && nextIndex < contexts.length) {
    startNext();
  }

  while (pending.length > 0) {
    const { index, result } = await Promise.race(
      pending.map(async (entry, index) => ({ index, result: await entry.promise! })),
    );
    const entry = pending[index];

    if (result.done) {
      pending.splice(index, 1);
      running -= 1;
      startNext();
      continue;
    }

    yield result.value;
    if (result.value.type === "completed") {
      pending.splice(index, 1);
      running -= 1;
      startNext();
    } else {
      entry.promise = entry.gen.next();
    }
  }

  yield { type: "done" };
}
