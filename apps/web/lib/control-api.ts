function resolveControlApiBaseUrl(): string {
  return process.env.CONTROL_API_BASE_URL?.trim()
    || process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL?.trim()
    || "http://127.0.0.1:4001";
}

function resolveControlApiAuthToken(): string | null {
  return process.env.CONTROL_API_AUTH_TOKEN?.trim() || null;
}

export async function fetchControlApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const authToken = resolveControlApiAuthToken();

  if (authToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  return fetch(`${resolveControlApiBaseUrl()}${path}`, {
    ...init,
    headers,
  });
}

/**
 * Proxy an SSE stream from control-api. Passes the response body through
 * as-is, preserving all SSE headers.
 */
export async function proxyControlApiStream(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const upstream = await fetchControlApi(path, init);

  const headers = new Headers();
  for (const headerName of ["Content-Type", "Cache-Control", "Connection", "X-Run-Active"]) {
    const value = upstream.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function proxyControlApiResponse(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const upstream = await fetchControlApi(path, init);
  const body = await upstream.arrayBuffer();
  const headers = new Headers();

  for (const headerName of ["Content-Type", "Cache-Control"]) {
    const value = upstream.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  return new Response(body, {
    status: upstream.status,
    headers,
  });
}
