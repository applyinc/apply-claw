import { z } from "zod";

const controlApiEnvSchema = z.object({
  CONTROL_API_HOST: z.string().trim().min(1).optional(),
  CONTROL_API_PORT: z.coerce.number().int().positive().optional(),
  CONTROL_API_BASE_URL: z.string().trim().url().optional(),
  CONTROL_API_ALLOWED_ORIGIN: z.string().trim().optional(),
  CONTROL_API_AUTH_TOKEN: z.string().trim().min(1).optional(),
  NEXT_PUBLIC_CONTROL_API_BASE_URL: z.string().trim().url().optional(),
  OPENCLAW_GATEWAY_URL: z.string().trim().optional(),
  OPENCLAW_STATE_DIR: z.string().trim().optional(),
});

export type ControlApiConfig = {
  allowedOrigin: string | null;
  authToken: string | null;
  host: string;
  openClawGatewayUrl: string | null;
  openClawStateDir: string | null;
  port: number;
};

export function resolveControlApiConfig(env: NodeJS.ProcessEnv): ControlApiConfig {
  const parsed = controlApiEnvSchema.parse(env);

  return {
    allowedOrigin: parsed.CONTROL_API_ALLOWED_ORIGIN?.trim() || null,
    authToken: parsed.CONTROL_API_AUTH_TOKEN?.trim() || null,
    host: parsed.CONTROL_API_HOST ?? "0.0.0.0",
    openClawGatewayUrl: parsed.OPENCLAW_GATEWAY_URL?.trim() || null,
    openClawStateDir: parsed.OPENCLAW_STATE_DIR?.trim() || null,
    port: parsed.CONTROL_API_PORT ?? 4001,
  };
}

export function resolveControlApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const parsed = controlApiEnvSchema.parse(env);

  return parsed.NEXT_PUBLIC_CONTROL_API_BASE_URL
    ?? parsed.CONTROL_API_BASE_URL
    ?? "http://127.0.0.1:4001";
}

export function resolveControlApiAuthToken(env: NodeJS.ProcessEnv): string | null {
  const parsed = controlApiEnvSchema.parse(env);

  return parsed.CONTROL_API_AUTH_TOKEN?.trim() || null;
}
