import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { PostHog } from "posthog-node";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";
const DENCHCLAW_VERSION = process.env.NEXT_PUBLIC_DENCHCLAW_VERSION || "";
const OPENCLAW_VERSION = process.env.NEXT_PUBLIC_OPENCLAW_VERSION || "";

let client: PostHog | null = null;

function ensureClient(): PostHog | null {
  if (!POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 10,
      flushInterval: 30_000,
    });
  }
  return client;
}

let _cachedAnonymousId: string | null = null;

/**
 * Read the persisted install-scoped anonymous ID from ~/.openclaw-dench/telemetry.json,
 * generating and writing one if absent.
 */
export function getOrCreateAnonymousId(): string {
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

export function trackServer(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  const ph = ensureClient();
  if (!ph) return;

  ph.capture({
    distinctId: distinctId || getOrCreateAnonymousId(),
    event,
    properties: {
      ...properties,
      denchclaw_version: DENCHCLAW_VERSION || undefined,
      openclaw_version: OPENCLAW_VERSION || undefined,
      $process_person_profile: false,
    },
  });
}
