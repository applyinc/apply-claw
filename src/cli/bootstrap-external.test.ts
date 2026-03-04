import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildBootstrapDiagnostics,
  checkAgentAuth,
  resolveBootstrapRolloutStage,
  isLegacyFallbackEnabled,
  type BootstrapDiagnostics,
} from "./bootstrap-external.js";

function getCheck(
  diagnostics: BootstrapDiagnostics,
  id: BootstrapDiagnostics["checks"][number]["id"],
) {
  const check = diagnostics.checks.find((item) => item.id === id);
  expect(check).toBeDefined();
  return check!;
}

function createTempStateDir(): string {
  const homeDir = path.join(
    tmpdir(),
    `denchclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const stateDir = path.join(homeDir, ".openclaw-dench");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function writeConfig(stateDir: string, config: Record<string, unknown>): void {
  writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
}

function writeAuthProfiles(stateDir: string, profiles: Record<string, unknown>): void {
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify(profiles));
}

describe("bootstrap-external diagnostics", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
    writeConfig(stateDir, {
      agents: { defaults: { model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" } } },
    });
    writeAuthProfiles(stateDir, {
      version: 1,
      profiles: {
        "vercel-ai-gateway:default": {
          type: "api_key",
          provider: "vercel-ai-gateway",
          key: "vck_test_key_1234567890",
        },
      },
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const baseParams = (dir: string) => ({
    profile: "dench",
    openClawCliAvailable: true,
    openClawVersion: "2026.3.1",
    gatewayPort: 18789,
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayProbe: { ok: true as const },
    webPort: 3100,
    webReachable: true,
    rolloutStage: "default" as const,
    legacyFallbackEnabled: false,
    stateDir: dir,
    env: { HOME: path.dirname(dir), OPENCLAW_HOME: path.dirname(dir) },
  });

  it("reports passing checks including agent-auth when config and keys exist", () => {
    const diagnostics = buildBootstrapDiagnostics(baseParams(stateDir));

    expect(getCheck(diagnostics, "profile").status).toBe("pass");
    expect(getCheck(diagnostics, "gateway").status).toBe("pass");
    expect(getCheck(diagnostics, "agent-auth").status).toBe("pass");
    expect(getCheck(diagnostics, "web-ui").status).toBe("pass");
    expect(diagnostics.hasFailures).toBe(false);
  });

  it("fails agent-auth when auth-profiles.json is missing (catches missing onboard)", () => {
    const emptyDir = createTempStateDir();
    writeConfig(emptyDir, {
      agents: { defaults: { model: { primary: "vercel-ai-gateway/anthropic/claude-4" } } },
    });

    try {
      const diagnostics = buildBootstrapDiagnostics(baseParams(emptyDir));
      const auth = getCheck(diagnostics, "agent-auth");
      expect(auth.status).toBe("fail");
      expect(auth.detail).toContain("auth-profiles.json");
      expect(auth.remediation).toContain("onboard --install-daemon");
      expect(diagnostics.hasFailures).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("fails agent-auth when key exists for wrong provider (catches provider mismatch)", () => {
    const dir = createTempStateDir();
    writeConfig(dir, {
      agents: { defaults: { model: { primary: "anthropic/claude-4" } } },
    });
    writeAuthProfiles(dir, {
      profiles: {
        "openai:default": { provider: "openai", key: "sk-test" },
      },
    });

    try {
      const diagnostics = buildBootstrapDiagnostics(baseParams(dir));
      const auth = getCheck(diagnostics, "agent-auth");
      expect(auth.status).toBe("fail");
      expect(auth.detail).toContain('"anthropic"');
      expect(auth.remediation).toContain("onboard --install-daemon");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails agent-auth when no model provider is configured", () => {
    const dir = createTempStateDir();
    writeConfig(dir, { agents: {} });

    try {
      const diagnostics = buildBootstrapDiagnostics(baseParams(dir));
      const auth = getCheck(diagnostics, "agent-auth");
      expect(auth.status).toBe("fail");
      expect(auth.detail).toContain("No model provider configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces actionable remediation for gateway auth failures", () => {
    const diagnostics = buildBootstrapDiagnostics({
      ...baseParams(stateDir),
      gatewayProbe: { ok: false as const, detail: "Unauthorized: token mismatch" },
    });

    const gateway = getCheck(diagnostics, "gateway");
    expect(gateway.status).toBe("fail");
    expect(String(gateway.remediation)).toContain("onboard");
    expect(String(gateway.remediation)).not.toContain("dangerouslyDisableDeviceAuth");
    expect(diagnostics.hasFailures).toBe(true);
  });

  it("includes break-glass guidance only for device signature/token mismatch failures", () => {
    const diagnostics = buildBootstrapDiagnostics({
      ...baseParams(stateDir),
      gatewayProbe: {
        ok: false as const,
        detail: "gateway connect failed: device signature invalid",
      },
    });

    const gateway = getCheck(diagnostics, "gateway");
    expect(gateway.status).toBe("fail");
    expect(String(gateway.remediation)).toContain("dangerouslyDisableDeviceAuth true");
    expect(String(gateway.remediation)).toContain("dangerouslyDisableDeviceAuth false");
    expect(String(gateway.remediation)).toContain("--profile dench");
  });

  it("marks rollout-stage as warning for beta and includes opt-in guidance", () => {
    const diagnostics = buildBootstrapDiagnostics({
      ...baseParams(stateDir),
      rolloutStage: "beta",
    });

    const rollout = getCheck(diagnostics, "rollout-stage");
    expect(rollout.status).toBe("warn");
    expect(String(rollout.remediation)).toContain("DENCHCLAW_BOOTSTRAP_BETA_OPT_IN");
  });

  it("fails cutover-gates when enforcement is enabled without gate envs", () => {
    const diagnostics = buildBootstrapDiagnostics({
      ...baseParams(stateDir),
      env: {
        HOME: path.dirname(stateDir),
        OPENCLAW_HOME: path.dirname(stateDir),
        DENCHCLAW_BOOTSTRAP_ENFORCE_SAFETY_GATES: "1",
      },
    });

    expect(getCheck(diagnostics, "cutover-gates").status).toBe("fail");
    expect(diagnostics.hasFailures).toBe(true);
  });

  it("passes cutover-gates when both required gate envs are set", () => {
    const diagnostics = buildBootstrapDiagnostics({
      ...baseParams(stateDir),
      env: {
        HOME: path.dirname(stateDir),
        OPENCLAW_HOME: path.dirname(stateDir),
        DENCHCLAW_BOOTSTRAP_MIGRATION_SUITE_OK: "1",
        DENCHCLAW_BOOTSTRAP_ONBOARDING_E2E_OK: "1",
      },
    });

    expect(getCheck(diagnostics, "cutover-gates").status).toBe("pass");
  });
});

describe("checkAgentAuth", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns ok when a valid key exists for the requested provider", () => {
    writeAuthProfiles(stateDir, {
      profiles: {
        "vercel-ai-gateway:default": {
          provider: "vercel-ai-gateway",
          key: "vck_valid_key",
        },
      },
    });
    const result = checkAgentAuth(stateDir, "vercel-ai-gateway");
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("vercel-ai-gateway");
  });

  it("returns not ok when auth-profiles.json does not exist", () => {
    const result = checkAgentAuth(stateDir, "vercel-ai-gateway");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("auth-profiles.json");
  });

  it("returns not ok when key exists for a different provider", () => {
    writeAuthProfiles(stateDir, {
      profiles: {
        "openai:default": { provider: "openai", key: "sk-test" },
      },
    });
    const result = checkAgentAuth(stateDir, "anthropic");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('"anthropic"');
  });

  it("returns not ok when key string is empty", () => {
    writeAuthProfiles(stateDir, {
      profiles: {
        "vercel-ai-gateway:default": { provider: "vercel-ai-gateway", key: "" },
      },
    });
    const result = checkAgentAuth(stateDir, "vercel-ai-gateway");
    expect(result.ok).toBe(false);
  });

  it("returns not ok when provider is undefined", () => {
    const result = checkAgentAuth(stateDir, undefined);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("No model provider configured");
  });

  it("returns not ok when profiles object is empty", () => {
    writeAuthProfiles(stateDir, { profiles: {} });
    const result = checkAgentAuth(stateDir, "vercel-ai-gateway");
    expect(result.ok).toBe(false);
  });
});

describe("bootstrap-external rollout env helpers", () => {
  it("resolves rollout stage from denchclaw/openclaw env vars", () => {
    expect(resolveBootstrapRolloutStage({ DENCHCLAW_BOOTSTRAP_ROLLOUT: "beta" })).toBe("beta");
    expect(resolveBootstrapRolloutStage({ OPENCLAW_BOOTSTRAP_ROLLOUT: "internal" })).toBe(
      "internal",
    );
    expect(resolveBootstrapRolloutStage({ DENCHCLAW_BOOTSTRAP_ROLLOUT: "invalid" })).toBe(
      "default",
    );
  });

  it("detects legacy fallback via either env namespace", () => {
    expect(isLegacyFallbackEnabled({ DENCHCLAW_BOOTSTRAP_LEGACY_FALLBACK: "1" })).toBe(true);
    expect(isLegacyFallbackEnabled({ OPENCLAW_BOOTSTRAP_LEGACY_FALLBACK: "true" })).toBe(true);
    expect(isLegacyFallbackEnabled({})).toBe(false);
  });
});
