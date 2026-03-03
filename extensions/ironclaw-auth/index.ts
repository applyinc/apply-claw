import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";
import { loginIronclawOAuth, type IronclawOAuthConfig } from "./oauth.js";

const PLUGIN_ID = "ironclaw-auth";
const PROVIDER_ID = "ironclaw";
const PROVIDER_LABEL = "Ironclaw";
const OAUTH_PLACEHOLDER = "ironclaw-oauth";
const DEFAULT_AUTH_URL = "https://auth.ironclaw.ai/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://auth.ironclaw.ai/oauth/token";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:47089/oauth/callback";
const DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access"];
const DEFAULT_BASE_URL = "https://api.ironclaw.ai/v1";
const DEFAULT_MODEL_ID = "chat";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

const CLIENT_ID_KEYS = ["IRONCLAW_OAUTH_CLIENT_ID", "OPENCLAW_IRONCLAW_OAUTH_CLIENT_ID"];
const CLIENT_SECRET_KEYS = [
  "IRONCLAW_OAUTH_CLIENT_SECRET",
  "OPENCLAW_IRONCLAW_OAUTH_CLIENT_SECRET",
];
const AUTH_URL_KEYS = ["IRONCLAW_OAUTH_AUTH_URL", "OPENCLAW_IRONCLAW_OAUTH_AUTH_URL"];
const TOKEN_URL_KEYS = ["IRONCLAW_OAUTH_TOKEN_URL", "OPENCLAW_IRONCLAW_OAUTH_TOKEN_URL"];
const REDIRECT_URI_KEYS = ["IRONCLAW_OAUTH_REDIRECT_URI", "OPENCLAW_IRONCLAW_OAUTH_REDIRECT_URI"];
const SCOPES_KEYS = ["IRONCLAW_OAUTH_SCOPES", "OPENCLAW_IRONCLAW_OAUTH_SCOPES"];
const USERINFO_URL_KEYS = ["IRONCLAW_OAUTH_USERINFO_URL", "OPENCLAW_IRONCLAW_OAUTH_USERINFO_URL"];
const BASE_URL_KEYS = [
  "IRONCLAW_PROVIDER_BASE_URL",
  "IRONCLAW_API_BASE_URL",
  "OPENCLAW_IRONCLAW_PROVIDER_BASE_URL",
];
const MODEL_IDS_KEYS = [
  "IRONCLAW_PROVIDER_MODEL_IDS",
  "IRONCLAW_MODEL_IDS",
  "OPENCLAW_IRONCLAW_MODEL_IDS",
];
const DEFAULT_MODEL_KEYS = [
  "IRONCLAW_PROVIDER_DEFAULT_MODEL",
  "IRONCLAW_DEFAULT_MODEL",
  "OPENCLAW_IRONCLAW_DEFAULT_MODEL",
];

const ENV_VARS = [
  ...CLIENT_ID_KEYS,
  ...CLIENT_SECRET_KEYS,
  ...AUTH_URL_KEYS,
  ...TOKEN_URL_KEYS,
  ...REDIRECT_URI_KEYS,
  ...SCOPES_KEYS,
  ...USERINFO_URL_KEYS,
  ...BASE_URL_KEYS,
  ...MODEL_IDS_KEYS,
  ...DEFAULT_MODEL_KEYS,
];

function resolveEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function stripProviderPrefix(model: string): string {
  const normalized = model.trim();
  if (normalized.startsWith(`${PROVIDER_ID}/`)) {
    return normalized.slice(PROVIDER_ID.length + 1);
  }
  return normalized;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const items = value
    .split(/[\s,]+/)
    .map((item) => stripProviderPrefix(item))
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items));
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol =
    raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");
  return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

function resolveDefaultModelId(modelIds: string[]): string {
  const configured = resolveEnv(DEFAULT_MODEL_KEYS);
  const fallback = modelIds[0] ?? DEFAULT_MODEL_ID;
  if (!configured) {
    return fallback;
  }
  const normalized = stripProviderPrefix(configured);
  return normalized.length > 0 ? normalized : fallback;
}

function buildModelDefinition(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function resolveOAuthConfig(): IronclawOAuthConfig {
  const clientId = resolveEnv(CLIENT_ID_KEYS);
  if (!clientId) {
    throw new Error(
      ["Ironclaw OAuth client id is required.", `Set one of: ${CLIENT_ID_KEYS.join(", ")}`].join(
        "\n",
      ),
    );
  }

  const scopes = parseList(resolveEnv(SCOPES_KEYS));
  return {
    clientId,
    clientSecret: resolveEnv(CLIENT_SECRET_KEYS),
    authUrl: resolveEnv(AUTH_URL_KEYS) || DEFAULT_AUTH_URL,
    tokenUrl: resolveEnv(TOKEN_URL_KEYS) || DEFAULT_TOKEN_URL,
    redirectUri: resolveEnv(REDIRECT_URI_KEYS) || DEFAULT_REDIRECT_URI,
    scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES,
    userInfoUrl: resolveEnv(USERINFO_URL_KEYS),
  };
}

function buildAuthResult(params: {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
}): ProviderAuthResult {
  const providerBaseUrl = normalizeBaseUrl(resolveEnv(BASE_URL_KEYS));
  const modelIds = parseList(resolveEnv(MODEL_IDS_KEYS));
  const normalizedModelIds = modelIds.length > 0 ? modelIds : [DEFAULT_MODEL_ID];
  const defaultModelId = resolveDefaultModelId(normalizedModelIds);
  const finalModelIds = normalizedModelIds.includes(defaultModelId)
    ? normalizedModelIds
    : [defaultModelId, ...normalizedModelIds];

  const defaultModel = `${PROVIDER_ID}/${defaultModelId}`;
  const agentModels = Object.fromEntries(
    finalModelIds.map((modelId, index) => [
      `${PROVIDER_ID}/${modelId}`,
      index === 0 ? { alias: "ironclaw" } : {},
    ]),
  );

  return {
    profiles: [
      {
        profileId: `${PROVIDER_ID}:default`,
        credential: {
          type: "oauth",
          provider: PROVIDER_ID,
          access: params.access,
          refresh: params.refresh,
          expires: params.expires,
        },
      },
    ],
    configPatch: {
      models: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: providerBaseUrl,
            apiKey: OAUTH_PLACEHOLDER,
            api: "openai-completions",
            models: finalModelIds.map((modelId) => buildModelDefinition(modelId)),
          },
        },
      },
      agents: {
        defaults: {
          models: agentModels,
        },
      },
    },
    defaultModel,
    notes: [
      `Configured ${PROVIDER_ID} provider at ${providerBaseUrl}.`,
      `Default model set to ${defaultModel}.`,
      ...(params.email ? [`Authenticated as ${params.email}.`] : []),
    ],
  };
}

const ironclawAuthPlugin = {
  id: PLUGIN_ID,
  name: "Ironclaw OAuth",
  description: "OAuth flow for Ironclaw-hosted models",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["ironclaw-ai"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "oauth",
          label: "Ironclaw OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            const progress = ctx.prompter.progress("Starting Ironclaw OAuth...");
            try {
              const oauthConfig = resolveOAuthConfig();
              const result = await loginIronclawOAuth(
                {
                  isRemote: ctx.isRemote,
                  openUrl: ctx.openUrl,
                  log: (message) => ctx.runtime.log(message),
                  note: ctx.prompter.note,
                  prompt: async (message) => String(await ctx.prompter.text({ message })),
                  progress,
                },
                oauthConfig,
              );

              progress.stop("Ironclaw OAuth complete");
              return buildAuthResult(result);
            } catch (error) {
              progress.stop("Ironclaw OAuth failed");
              await ctx.prompter.note(
                [
                  "Set IRONCLAW_OAUTH_CLIENT_ID (and optionally auth/token URLs) before retrying.",
                  "You can also configure model ids with IRONCLAW_PROVIDER_MODEL_IDS.",
                ].join("\n"),
                "Ironclaw OAuth",
              );
              throw error;
            }
          },
        },
      ],
    });
  },
};

export default ironclawAuthPlugin;
