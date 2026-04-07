import { serve } from "@hono/node-server";

import { resolveControlApiConfig } from "@applyclaw/shared-config";

import { createControlApiApp } from "./app.js";
import { startTerminalServer } from "./terminal-service.js";

const config = resolveControlApiConfig(process.env);
const app = createControlApiApp();

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`control-api listening on http://${info.address}:${info.port}`);
  },
);

// Start the terminal WebSocket server (PTY over WS)
startTerminalServer(Number(process.env.TERMINAL_WS_PORT) || 3101);
