import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { resolveControlApiConfig } from "@applyclaw/shared-config";

export function createCorsMiddleware(): MiddlewareHandler {
  const config = resolveControlApiConfig(process.env);

  return cors({
    origin: config.allowedOrigin ?? "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-Control-Api-Request-Id"],
    exposeHeaders: ["X-Control-Api-Request-Id"],
  });
}

export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Control-Api-Request-Id", requestId);
  await next();
};

export const requestLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const startedAt = Date.now();
  await next();

  console.log(
    JSON.stringify({
      durationMs: Date.now() - startedAt,
      method: c.req.method,
      path: c.req.path,
      requestId: c.get("requestId"),
      status: c.res.status,
      type: "request",
    }),
  );
};

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const config = resolveControlApiConfig(process.env);

  if (!config.authToken) {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  const expected = `Bearer ${config.authToken}`;

  if (authHeader !== expected) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token.",
        },
      },
      401,
    );
  }

  await next();
};
