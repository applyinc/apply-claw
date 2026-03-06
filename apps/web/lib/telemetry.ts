import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";

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

export function trackServer(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  const ph = ensureClient();
  if (!ph) return;

  ph.capture({
    distinctId: distinctId || randomUUID(),
    event,
    properties: {
      ...properties,
      $process_person_profile: false,
    },
  });
}
