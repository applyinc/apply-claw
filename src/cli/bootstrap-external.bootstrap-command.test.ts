import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { bootstrapCommand } from "./bootstrap-external.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

type SpawnCall = {
  command: string;
  args: string[];
  options?: { stdio?: unknown };
};

function createTempStateDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(os.tmpdir(), `ironclaw-bootstrap-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBootstrapFixtures(stateDir: string): void {
  const config = {
    agents: {
      defaults: {
        model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
      },
    },
    gateway: {
      mode: "local",
    },
  };
  writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));

  const authDir = path.join(stateDir, "agents", "main", "agent");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    path.join(authDir, "auth-profiles.json"),
    JSON.stringify({
      profiles: {
        "vercel-ai-gateway:default": {
          provider: "vercel-ai-gateway",
          key: "vck_test_123",
        },
      },
    }),
  );
}

function createMockChild(params: {
  code: number;
  stdout?: string;
  stderr?: string;
}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (params.stdout) {
      child.stdout.emit("data", Buffer.from(params.stdout));
    }
    if (params.stderr) {
      child.stderr.emit("data", Buffer.from(params.stderr));
    }
    child.emit("close", params.code);
  });

  return child;
}

describe("bootstrapCommand always-onboard behavior", () => {
  const originalEnv = { ...process.env };
  const spawnMock = vi.mocked(spawn);
  let stateDir = "";
  let spawnCalls: SpawnCall[] = [];
  let forceGlobalMissing = false;
  let globalDetectCount = 0;
  let healthFailuresBeforeSuccess = 0;
  let healthCallCount = 0;
  let alwaysHealthFail = false;

  beforeEach(() => {
    stateDir = createTempStateDir();
    writeBootstrapFixtures(stateDir);
    spawnCalls = [];
    forceGlobalMissing = false;
    globalDetectCount = 0;
    healthFailuresBeforeSuccess = 0;
    healthCallCount = 0;
    alwaysHealthFail = false;
    process.env = {
      ...originalEnv,
      OPENCLAW_PROFILE: "ironclaw",
      OPENCLAW_STATE_DIR: stateDir,
      VITEST: "true",
    };

    spawnMock.mockImplementation((command, args = [], options) => {
      const commandString = String(command);
      const argList = Array.isArray(args) ? args.map(String) : [];
      spawnCalls.push({
        command: commandString,
        args: argList,
        options: options as { stdio?: unknown } | undefined,
      });

      if (commandString === "openclaw" && argList[0] === "--version") {
        return createMockChild({ code: 0, stdout: "2026.3.1\n" }) as never;
      }
      if (
        commandString === "npm" &&
        argList.includes("ls") &&
        argList.includes("-g") &&
        argList.includes("openclaw")
      ) {
        globalDetectCount += 1;
        const reportMissing = forceGlobalMissing && globalDetectCount === 1;
        return createMockChild({
          code: reportMissing ? 1 : 0,
          stdout: reportMissing
            ? '{"dependencies":{}}'
            : '{"dependencies":{"openclaw":{"version":"2026.3.1"}}}',
        }) as never;
      }
      if (commandString === "npm" && argList.includes("prefix") && argList.includes("-g")) {
        return createMockChild({
          code: 0,
          stdout: `${path.join(stateDir, "npm-global")}\n`,
        }) as never;
      }
      if (commandString === "npm" && argList.includes("install") && argList.includes("-g")) {
        return createMockChild({ code: 0, stdout: "installed\n" }) as never;
      }
      if ((commandString === "which" || commandString === "where") && argList[0] === "openclaw") {
        return createMockChild({ code: 0, stdout: "/usr/local/bin/openclaw\n" }) as never;
      }
      if (
        commandString === "openclaw" &&
        argList.includes("config") &&
        argList.includes("get") &&
        argList.includes("gateway.mode")
      ) {
        return createMockChild({ code: 0, stdout: "local\n" }) as never;
      }
      if (commandString === "openclaw" && argList.includes("health")) {
        healthCallCount += 1;
        if (alwaysHealthFail || healthCallCount <= healthFailuresBeforeSuccess) {
          return createMockChild({
            code: 1,
            stderr: "gateway closed (1006 abnormal closure)\n",
          }) as never;
        }
        return createMockChild({ code: 0, stdout: '{"ok":true}\n' }) as never;
      }
      return createMockChild({ code: 0, stdout: "ok\n" }) as never;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200 }) as unknown as Response),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs onboard every bootstrap even when config already exists (prevents stale auth drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCalls = spawnCalls.filter(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.args).toEqual(
      expect.arrayContaining([
        "--profile",
        "ironclaw",
        "onboard",
        "--install-daemon",
        "--non-interactive",
        "--accept-risk",
        "--skip-ui",
      ]),
    );
    expect(onboardCalls[0]?.options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(summary.onboarded).toBe(true);
  });

  it("seeds workspace.duckdb on bootstrap when missing", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceDbPath = path.join(workspaceDir, "workspace.duckdb");
    expect(existsSync(workspaceDbPath)).toBe(false);

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(workspaceDbPath)).toBe(true);
    expect(summary.workspaceSeed?.seeded).toBe(true);
    expect(summary.workspaceSeed?.reason).toBe("seeded");
    expect(summary.workspaceSeed?.workspaceDir).toBe(workspaceDir);
  });

  it("skips workspace seeding when workspace.duckdb already exists", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceDbPath = path.join(workspaceDir, "workspace.duckdb");
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(workspaceDbPath, "existing-db-content", "utf-8");
    writeFileSync(identityPath, "# stale identity\n", "utf-8");

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(summary.workspaceSeed?.seeded).toBe(false);
    expect(summary.workspaceSeed?.reason).toBe("already-exists");
    expect(readFileSync(workspaceDbPath, "utf-8")).toBe("existing-db-content");
    const identityContent = readFileSync(identityPath, "utf-8");
    expect(identityContent).toContain("You are **Ironclaw**");
    expect(identityContent).toContain("~skills/dench/SKILL.md");
    expect(identityContent).not.toContain("# stale identity");
  });

  it("creates people/company/task object projection files when seeding a new workspace", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const customWorkspace = path.join(stateDir, "seed-projection-workspace");
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
            workspace: customWorkspace,
          },
        },
        gateway: { mode: "local" },
      }),
    );

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(summary.workspaceSeed?.seeded).toBe(true);
    expect(summary.workspaceSeed?.workspaceDir).toBe(customWorkspace);
    expect(existsSync(path.join(customWorkspace, "people", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(customWorkspace, "company", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(customWorkspace, "task", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(customWorkspace, "WORKSPACE.md"))).toBe(true);
    const identityPath = path.join(customWorkspace, "IDENTITY.md");
    expect(existsSync(identityPath)).toBe(true);
    const identityContent = readFileSync(identityPath, "utf-8");
    expect(identityContent).toContain("You are **Ironclaw**");
    expect(identityContent).toContain("~skills/dench/SKILL.md");
  });

  it("installs Dench skill into managed profile skills directory (keeps it out of editable workspace)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const targetSkill = path.join(stateDir, "skills", "dench", "SKILL.md");
    const workspaceSkill = path.join(stateDir, "workspace", "skills", "dench", "SKILL.md");
    expect(existsSync(targetSkill)).toBe(false);

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(targetSkill)).toBe(true);
    expect(existsSync(workspaceSkill)).toBe(false);
    expect(readFileSync(targetSkill, "utf-8")).toContain("name: database-crm-system");
  });

  it("replaces existing managed Dench skill on bootstrap (keeps updates in sync)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const targetDir = path.join(stateDir, "skills", "dench");
    const targetSkill = path.join(targetDir, "SKILL.md");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetSkill, "name: dench\n# custom\n");

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const content = readFileSync(targetSkill, "utf-8");
    expect(content).toContain("name: database-crm-system");
    expect(content).not.toContain("# custom");
  });

  it("keeps Dench in managed skills even when workspace path is custom", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const customWorkspace = path.join(stateDir, "custom-workspace-root");
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
            workspace: customWorkspace,
          },
        },
        gateway: { mode: "local" },
      }),
    );
    const managedSkill = path.join(stateDir, "skills", "dench", "SKILL.md");
    const workspaceSkill = path.join(customWorkspace, "skills", "dench", "SKILL.md");

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(managedSkill)).toBe(true);
    expect(existsSync(workspaceSkill)).toBe(false);
  });

  it("uses inherited stdio for onboarding in interactive mode (shows wizard prompts)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCalls = spawnCalls.filter(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.options?.stdio).toBe("inherit");
    expect(onboardCalls[0]?.args).not.toContain("--non-interactive");
    expect(onboardCalls[0]?.args).not.toContain("--accept-risk");
  });

  it("does not call gateway install/start fallback when onboarding is always used", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const gatewayInstallCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("gateway") &&
        call.args.includes("install"),
    );
    const gatewayStartCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("gateway") && call.args.includes("start"),
    );

    expect(gatewayInstallCalled).toBe(false);
    expect(gatewayStartCalled).toBe(false);
  });

  it("installs global OpenClaw even when a local binary already resolves", async () => {
    forceGlobalMissing = true;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const globalInstallCalls = spawnCalls.filter(
      (call) =>
        call.command === "npm" &&
        call.args.includes("install") &&
        call.args.includes("-g") &&
        call.args.includes("openclaw@latest"),
    );
    expect(globalInstallCalls.length).toBeGreaterThan(0);
    expect(summary.installedOpenClawCli).toBe(true);
  });

  it("runs doctor/gateway autofix steps when initial health probe fails", async () => {
    healthFailuresBeforeSuccess = 1;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const doctorFixCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("doctor") && call.args.includes("--fix"),
    );
    const gatewayInstallCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("gateway") &&
        call.args.includes("install"),
    );
    const gatewayStartCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("gateway") && call.args.includes("start"),
    );

    expect(doctorFixCalled).toBe(true);
    expect(gatewayInstallCalled).toBe(true);
    expect(gatewayStartCalled).toBe(true);
    expect(summary.gatewayReachable).toBe(true);
    expect(summary.gatewayAutoFix?.attempted).toBe(true);
    expect(summary.gatewayAutoFix?.recovered).toBe(true);
  });

  it("prints likely gateway cause with log excerpt when autofix cannot recover", async () => {
    alwaysHealthFail = true;
    mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    writeFileSync(
      path.join(stateDir, "logs", "gateway.err.log"),
      [
        "unauthorized: gateway token mismatch",
        "Invalid config",
        "plugins.slots.memory: plugin not found: memory-core",
      ].join("\n"),
    );

    const logSpy = vi.fn();
    const runtime: RuntimeEnv = {
      log: logSpy,
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );
    const logMessages = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");

    expect(summary.gatewayReachable).toBe(false);
    expect(summary.gatewayAutoFix?.attempted).toBe(true);
    expect(logMessages).toContain("Likely gateway cause:");
    expect(logMessages).toContain("gateway.err.log");
  });
});
