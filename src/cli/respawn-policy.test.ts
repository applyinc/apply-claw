import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";

describe("shouldSkipRespawnForArgv", () => {
  it("skips respawn for help/version invocations", () => {
    expect(shouldSkipRespawnForArgv(["node", "denchclaw", "--help"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "denchclaw", "-V"])).toBe(true);
  });

  it("does not skip respawn for normal command execution", () => {
    expect(shouldSkipRespawnForArgv(["node", "denchclaw", "chat", "send"])).toBe(false);
  });
});
