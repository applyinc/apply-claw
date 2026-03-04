import { describe, expect, it } from "vitest";
import { DEFAULT_CLI_NAME, replaceCliName, resolveCliName } from "./cli-name.js";

describe("cli-name", () => {
  it("resolves known CLI names from argv[1]", () => {
    expect(resolveCliName(["node", "openclaw"])).toBe("openclaw");
    expect(resolveCliName(["node", "denchclaw"])).toBe("denchclaw");
    expect(resolveCliName(["node", "/usr/local/bin/openclaw"])).toBe("openclaw");
  });

  it("falls back to default name for unknown binaries", () => {
    expect(resolveCliName(["node", "custom-cli"])).toBe(DEFAULT_CLI_NAME);
  });

  it("replaces CLI name in command prefixes while preserving package runner prefix", () => {
    expect(replaceCliName("openclaw status", "denchclaw")).toBe("denchclaw status");
    expect(replaceCliName("pnpm openclaw status", "denchclaw")).toBe("pnpm denchclaw status");
    expect(replaceCliName("npx denchclaw status", "openclaw")).toBe("npx openclaw status");
  });

  it("keeps command unchanged when it does not start with a known CLI prefix", () => {
    expect(replaceCliName("echo openclaw status", "denchclaw")).toBe("echo openclaw status");
    expect(replaceCliName("   ", "openclaw")).toBe("   ");
  });
});
