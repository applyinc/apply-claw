---
name: Bootstrap dev testing
overview: Remove local OpenClaw paths from the web app, always use global `openclaw` binary, rename dev scripts to `denchclaw`, and verify bootstrap works standalone.
todos:
  - id: remove-local-openclaw-agent-runner
    content: Remove resolvePackageRoot, resolveOpenClawLaunch, DENCHCLAW_USE_LOCAL_OPENCLAW from agent-runner.ts; spawn global `openclaw` directly
    status: completed
  - id: remove-local-openclaw-subagent-runs
    content: Remove local script paths from subagent-runs.ts (sendGatewayAbortForSubagent, spawnSubagentMessage); use global `openclaw` instead
    status: completed
  - id: rename-pnpm-scripts
    content: Rename `pnpm openclaw` to `pnpm denchclaw` and `openclaw:rpc` to `denchclaw:rpc` in package.json
    status: completed
  - id: update-agent-runner-tests
    content: "Update agent-runner.test.ts: remove resolvePackageRoot tests, DENCHCLAW_USE_LOCAL_OPENCLAW, update spawn assertions"
    status: completed
  - id: verify-builds-pass
    content: Verify pnpm build, pnpm web:build, and workspace tests pass after changes
    status: completed
isProject: false
---

# DenchClaw Bootstrap: Clean Separation and Dev Testing

## Architecture

DenchClaw is a frontend/UI/skills layer. OpenClaw is a separate, globally-installed runtime. DenchClaw should NEVER bundle or run a local copy of OpenClaw.

```mermaid
flowchart TD
    npx["npx denchclaw (or denchclaw)"] --> entry["openclaw.mjs → dist/entry.js"]
    entry --> runMain["run-main.ts: bare denchclaw → bootstrap"]
    runMain --> delegate{"primary == bootstrap?"}
    delegate -->|yes, keep local| bootstrap["bootstrapCommand()"]
    delegate -->|no, delegate| globalOC["spawn openclaw ...args"]
    bootstrap --> checkOC{"openclaw on PATH?"}
    checkOC -->|yes| onboard
    checkOC -->|no| prompt["Prompt: install openclaw globally?"]
    prompt -->|yes| npmInstall["npm install -g openclaw"]
    npmInstall --> onboard
    onboard["openclaw onboard --install-daemon"] --> gatewayStart["Gateway starts + spawns web app"]
    gatewayStart --> probe["waitForWebAppPort(3100)"]
    probe --> openBrowser["Open http://localhost:3100"]
```

The bootstrap flow is correctly wired:

- Bare `denchclaw` rewrites to `denchclaw bootstrap`
- `bootstrap` is never delegated to global `openclaw`
- `bootstrapCommand` calls `ensureOpenClawCliAvailable` which prompts to install
- Onboarding sets `gateway.webApp.enabled: true`
- Gateway starts the Next.js standalone server on port 3100
- Bootstrap probes and opens the browser

## Problem 1: Local OpenClaw paths in web app (must remove)

`[apps/web/lib/agent-runner.ts](apps/web/lib/agent-runner.ts)` has `resolveOpenClawLaunch` which, when `DENCHCLAW_USE_LOCAL_OPENCLAW=1`, resolves a local `scripts/run-node.mjs` or `openclaw.mjs` and spawns it with `node`. This contradicts the architecture: DenchClaw should always spawn the global `openclaw` binary.

The same pattern exists in `[apps/web/lib/subagent-runs.ts](apps/web/lib/subagent-runs.ts)` where `sendGatewayAbortForSubagent` and `spawnSubagentMessage` hardcode `node <local-script>` paths.

**Fix:**

- Remove `DENCHCLAW_USE_LOCAL_OPENCLAW`, `resolveOpenClawLaunch`, `resolvePackageRoot`, and `OpenClawLaunch` type from `agent-runner.ts`
- All spawn calls become `spawn("openclaw", [...args], { env, stdio })`
- In `subagent-runs.ts`: replace `node <scriptPath> gateway call ...` with `openclaw gateway call ...`
- Remove `resolvePackageRoot` import from `subagent-runs.ts`

## Problem 2: `pnpm openclaw` script name is wrong

`package.json` has `"openclaw": "node scripts/run-node.mjs"`. This repo IS DenchClaw, not OpenClaw.

**Fix:** Rename to `"denchclaw": "node scripts/run-node.mjs"`. Also `"openclaw:rpc"` to `"denchclaw:rpc"`.

## Dev workflow (after fixes)

```bash
# Prerequisite: install OpenClaw globally (one-time)
npm install -g openclaw

# Run DenchClaw bootstrap (installs/configures everything, opens UI)
pnpm denchclaw

# Or for web UI dev only:
openclaw --profile denchclaw gateway --port 18789   # Terminal 1
pnpm web:dev                                        # Terminal 2
```

## Implementation details

### 1. Simplify agent-runner.ts spawning

Remove ~40 lines (`resolvePackageRoot`, `OpenClawLaunch`, `resolveOpenClawLaunch`). Both `spawnLegacyAgentProcess` and `spawnLegacyAgentSubscribeProcess` become:

```typescript
function spawnLegacyAgentProcess(message: string, agentSessionId?: string) {
  const args = ["agent", "--agent", "main", "--message", message, "--stream-json"];
  if (agentSessionId) {
    const sessionKey = `agent:main:web:${agentSessionId}`;
    args.push("--session-key", sessionKey, "--lane", "web", "--channel", "webchat");
  }
  const profile = getEffectiveProfile();
  const workspace = resolveWorkspaceRoot();
  return spawn("openclaw", args, {
    env: {
      ...process.env,
      ...(profile ? { OPENCLAW_PROFILE: profile } : {}),
      ...(workspace ? { OPENCLAW_WORKSPACE: workspace } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
```

### 2. Simplify subagent-runs.ts spawning

`sendGatewayAbortForSubagent` and `spawnSubagentMessage` both have this pattern:

```typescript
const root = resolvePackageRoot();
const devScript = join(root, "scripts", "run-node.mjs");
const prodScript = join(root, "openclaw.mjs");
const scriptPath = existsSync(devScript) ? devScript : prodScript;
spawn("node", [scriptPath, "gateway", "call", ...], { cwd: root, ... });
```

Replace with:

```typescript
spawn("openclaw", ["gateway", "call", ...], { env: process.env, ... });
```

### 3. Update agent-runner.test.ts

- Remove `process.env.DENCHCLAW_USE_LOCAL_OPENCLAW = "1"` from `beforeEach`
- Remove entire `resolvePackageRoot` describe block (~5 tests)
- The "uses global openclaw by default" test becomes the only spawn behavior test
- Update mock assertions: command is always `"openclaw"`, no `prefixArgs`

### 4. Rename package.json scripts

```diff
-    "openclaw": "node scripts/run-node.mjs",
-    "openclaw:rpc": "node scripts/run-node.mjs agent --mode rpc --json",
+    "denchclaw": "node scripts/run-node.mjs",
+    "denchclaw:rpc": "node scripts/run-node.mjs agent --mode rpc --json",
```
