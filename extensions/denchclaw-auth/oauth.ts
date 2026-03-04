import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { isWSL2Sync } from "openclaw/plugin-sdk";

const RESPONSE_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>DenchClaw OAuth</title>
  </head>
  <body>
    <main>
      <h1>Authentication complete</h1>
      <p>You can return to the terminal.</p>
    </main>
  </body>
</html>`;

export type DenchClawOAuthConfig = {
  clientId: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
  userInfoUrl?: string;
};

export type DenchClawOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
};

export type DenchClawOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (message: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
};

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function shouldUseManualOAuthFlow(isRemote: boolean): boolean {
  return isRemote || isWSL2Sync();
}

function normalizeUrl(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function buildAuthUrl(params: {
  config: DenchClawOAuthConfig;
  challenge: string;
  state: string;
}): string {
  const authUrl = normalizeUrl(params.config.authUrl, "DENCHCLAW_OAUTH_AUTH_URL");
  const url = new URL(authUrl);
  url.searchParams.set("client_id", params.config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.config.redirectUri);
  url.searchParams.set("scope", params.config.scopes.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function parseCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? expectedState;
    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: "Missing 'state' parameter in URL" };
    }
    return { code, state };
  } catch {
    if (!expectedState) {
      return { error: "Paste the full redirect URL instead of only the code." };
    }
    return { code: trimmed, state: expectedState };
  }
}

async function startCallbackServer(params: { redirectUri: string; timeoutMs: number }) {
  const redirect = new URL(normalizeUrl(params.redirectUri, "DENCHCLAW_OAUTH_REDIRECT_URI"));
  const port = redirect.port ? Number(redirect.port) : 80;
  const host =
    redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1"
      ? redirect.hostname
      : "127.0.0.1";

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (error: Error) => void;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(url);
    };
    rejectCallback = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
  });

  const timeout = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, params.timeoutMs);
  timeout.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Missing callback URL");
      return;
    }

    const callbackUrl = new URL(request.url, `${redirect.protocol}//${redirect.host}`);
    if (callbackUrl.pathname !== redirect.pathname) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(RESPONSE_PAGE);
    resolveCallback(callbackUrl);
    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function exchangeCode(params: {
  config: DenchClawOAuthConfig;
  code: string;
  verifier: string;
}): Promise<DenchClawOAuthCredentials> {
  const tokenUrl = normalizeUrl(params.config.tokenUrl, "DENCHCLAW_OAUTH_TOKEN_URL");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.config.redirectUri,
    code_verifier: params.verifier,
    client_id: params.config.clientId,
  });
  if (params.config.clientSecret?.trim()) {
    body.set("client_secret", params.config.clientSecret.trim());
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text || response.statusText}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  const expiresIn = Math.max(60, Number(data.expires_in) || 3600);
  if (!access) {
    throw new Error("Token exchange returned no access_token");
  }
  if (!refresh) {
    throw new Error("Token exchange returned no refresh_token");
  }

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
  };
}

async function fetchUserEmail(
  config: DenchClawOAuthConfig,
  accessToken: string,
): Promise<string | undefined> {
  if (!config.userInfoUrl?.trim()) {
    return undefined;
  }
  let url: string;
  try {
    url = normalizeUrl(config.userInfoUrl, "DENCHCLAW_OAUTH_USERINFO_URL");
  } catch {
    return undefined;
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as {
      email?: string;
      user?: { email?: string };
    };
    return payload.email ?? payload.user?.email;
  } catch {
    return undefined;
  }
}

export async function loginDenchClawOAuth(
  ctx: DenchClawOAuthContext,
  config: DenchClawOAuthConfig,
): Promise<DenchClawOAuthCredentials> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl({ config, challenge, state });
  const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);

  let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | null = null;
  if (!needsManual) {
    try {
      callbackServer = await startCallbackServer({
        redirectUri: config.redirectUri,
        timeoutMs: 5 * 60 * 1000,
      });
    } catch {
      callbackServer = null;
    }
  }

  if (!callbackServer) {
    await ctx.note(
      [
        "Open the URL in your local browser and complete sign-in.",
        "After redirect, paste the full callback URL here.",
        "",
        `Auth URL: ${authUrl}`,
        `Redirect URI: ${config.redirectUri}`,
      ].join("\n"),
      "DenchClaw OAuth",
    );
    ctx.log("");
    ctx.log("Copy this URL:");
    ctx.log(authUrl);
    ctx.log("");
  } else {
    ctx.progress.update("Opening DenchClaw sign-in...");
    try {
      await ctx.openUrl(authUrl);
    } catch {
      ctx.log("");
      ctx.log("Open this URL in your browser:");
      ctx.log(authUrl);
      ctx.log("");
    }
  }

  let code = "";
  let returnedState = "";
  try {
    if (callbackServer) {
      ctx.progress.update("Waiting for OAuth callback...");
      const callback = await callbackServer.waitForCallback();
      code = callback.searchParams.get("code") ?? "";
      returnedState = callback.searchParams.get("state") ?? "";
    } else {
      ctx.progress.update("Waiting for redirect URL...");
      const input = await ctx.prompt("Paste the redirect URL: ");
      const parsed = parseCallbackInput(input, state);
      if ("error" in parsed) {
        throw new Error(parsed.error);
      }
      code = parsed.code;
      returnedState = parsed.state;
    }
  } finally {
    await callbackServer?.close().catch(() => undefined);
  }

  if (!code) {
    throw new Error("Missing OAuth code");
  }
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch. Please try again.");
  }

  ctx.progress.update("Exchanging authorization code...");
  const tokens = await exchangeCode({ config, code, verifier });
  const email = await fetchUserEmail(config, tokens.access);
  return email ? { ...tokens, email } : tokens;
}
