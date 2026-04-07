import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";

import { resolveControlApiConfig } from "@applyclaw/shared-config";

import { createControlApiApp } from "./app.js";
import { attachTerminalServer } from "./terminal-service.js";

const config = resolveControlApiConfig(process.env);
const app = createControlApiApp();

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`control-api listening on http://${info.address}:${info.port}`);
  },
);

// Attach terminal WebSocket handler to the same HTTP server (path: /ws/terminal)
// serve() returns ServerType (http.Server | http2.Http2SecureServer) — we use HTTP.
attachTerminalServer(server as unknown as HttpServer);
