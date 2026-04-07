import type { Context } from "hono";

import { resolveControlApiConfig, type ControlApiConfig } from "@applyclaw/shared-config";

export type ControlApiEnv = {
  Variables: {
    requestId: string;
  };
};

export type ControlApiContext = {
  authTokenConfigured: boolean;
  config: ControlApiConfig;
  requestId: string;
};

export function buildControlApiContext(c: Context<ControlApiEnv>): ControlApiContext {
  const config = resolveControlApiConfig(process.env);

  return {
    authTokenConfigured: Boolean(config.authToken),
    config,
    requestId: c.get("requestId"),
  };
}
