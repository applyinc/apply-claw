import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import type { AppRouter } from "@applyclaw/control-api/router";
import {
  resolveControlApiAuthToken,
  resolveControlApiBaseUrl,
} from "@applyclaw/shared-config";

export function createControlApiClient(
  baseUrl = resolveControlApiBaseUrl(process.env),
) {
  const authToken = resolveControlApiAuthToken(process.env);

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        headers() {
          return authToken ? { Authorization: `Bearer ${authToken}` } : {};
        },
        url: `${baseUrl}/trpc`,
      }),
    ],
  });
}
