/**
 * Server-side telemetry — ported from apps/web/lib/telemetry.ts
 *
 * Sends events to PostHog when configured via POSTHOG_KEY env.
 * Gracefully no-ops when PostHog is not configured.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const POSTHOG_KEY = process.env.POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";
const DENCHCLAW_VERSION = process.env.DENCHCLAW_VERSION || process.env.NEXT_PUBLIC_DENCHCLAW_VERSION || "";
const OPENCLAW_VERSION = process.env.OPENCLAW_VERSION || process.env.NEXT_PUBLIC_OPENCLAW_VERSION || "";

type PersonInfo = {
  name?: string;
  email?: string;
  avatar?: string;
  denchOrgId?: string;
};

// Lazy-loaded PostHog client (optional dependency)
let _phModule: typeof import("posthog-node") | null | undefined = undefined;
let _client: InstanceType<typeof import("posthog-node").PostHog> | null = null;

async function ensureClient(): Promise<typeof _client> {
  if (!POSTHOG_KEY) return null;
  if (_client) return _client;
  if (_phModule === null) return null; // previously failed to load

  try {
    if (_phModule === undefined) {
      _phModule = await import("posthog-node");
    }
    _client = new _phModule.PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 10,
      flushInterval: 30_000,
    });
    return _client;
  } catch {
    _phModule = null;
    return null;
  }
}

let _cachedAnonymousId: string | null = null;
let _cachedPersonInfo: PersonInfo | null | undefined = undefined;
let _identified = false;

function getOrCreateAnonymousId(): string {
  if (_cachedAnonymousId) return _cachedAnonymousId;
  try {
    const stateDir = join(process.env.HOME || homedir(), ".openclaw-dench");
    const configPath = join(stateDir, "telemetry.json");
    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    }
    if (typeof raw.anonymousId === "string" && raw.anonymousId) {
      _cachedAnonymousId = raw.anonymousId;
      return raw.anonymousId;
    }
    const id = randomUUID();
    raw.anonymousId = id;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    _cachedAnonymousId = id;
    return id;
  } catch {
    const id = randomUUID();
    _cachedAnonymousId = id;
    return id;
  }
}

function readPersonInfo(): PersonInfo | null {
  if (_cachedPersonInfo !== undefined) return _cachedPersonInfo;
  try {
    const stateDir = join(process.env.HOME || homedir(), ".openclaw-dench");
    const configPath = join(stateDir, "telemetry.json");
    if (!existsSync(configPath)) { _cachedPersonInfo = null; return null; }
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const info: PersonInfo = {};
    if (typeof raw.name === "string" && raw.name) info.name = raw.name;
    if (typeof raw.email === "string" && raw.email) info.email = raw.email;
    if (typeof raw.avatar === "string" && raw.avatar) info.avatar = raw.avatar;
    if (typeof raw.denchOrgId === "string" && raw.denchOrgId) info.denchOrgId = raw.denchOrgId;
    _cachedPersonInfo = Object.keys(info).length > 0 ? info : null;
    return _cachedPersonInfo;
  } catch {
    _cachedPersonInfo = null;
    return null;
  }
}

export function trackServer(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  // Fire-and-forget async
  void (async () => {
    const ph = await ensureClient();
    if (!ph) return;
    const id = distinctId || getOrCreateAnonymousId();
    if (!_identified) {
      _identified = true;
      const person = readPersonInfo();
      if (person) {
        const props: Record<string, string> = {};
        if (person.name) props.$name = person.name;
        if (person.email) props.$email = person.email;
        if (person.avatar) props.$avatar = person.avatar;
        if (person.denchOrgId) props.dench_org_id = person.denchOrgId;
        ph.identify({ distinctId: id, properties: props });
      }
    }
    ph.capture({
      distinctId: id,
      event,
      properties: {
        ...properties,
        denchclaw_version: DENCHCLAW_VERSION || undefined,
        openclaw_version: OPENCLAW_VERSION || undefined,
      },
    });
  })();
}
