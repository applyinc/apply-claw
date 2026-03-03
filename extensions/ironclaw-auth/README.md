# Ironclaw OAuth (OpenClaw plugin)

OAuth provider plugin for Ironclaw-hosted models.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable ironclaw-auth
```

Restart the Gateway after enabling.

## Authenticate

Set at least a client id, then run provider login:

```bash
export IRONCLAW_OAUTH_CLIENT_ID="<your-client-id>"
openclaw models auth login --provider ironclaw --set-default
```

## Optional env vars

- `IRONCLAW_OAUTH_CLIENT_SECRET`
- `IRONCLAW_OAUTH_AUTH_URL` (default: `https://auth.ironclaw.ai/oauth/authorize`)
- `IRONCLAW_OAUTH_TOKEN_URL` (default: `https://auth.ironclaw.ai/oauth/token`)
- `IRONCLAW_OAUTH_REDIRECT_URI` (default: `http://127.0.0.1:47089/oauth/callback`)
- `IRONCLAW_OAUTH_SCOPES` (space/comma separated)
- `IRONCLAW_OAUTH_USERINFO_URL` (optional for email display)
- `IRONCLAW_PROVIDER_BASE_URL` (default: `https://api.ironclaw.ai/v1`)
- `IRONCLAW_PROVIDER_MODEL_IDS` (space/comma separated, default: `chat`)
- `IRONCLAW_PROVIDER_DEFAULT_MODEL` (default: first model id)

## Notes

- This plugin configures `models.providers.ironclaw` as `openai-completions`.
- OAuth tokens are stored in auth profiles and the provider is patched into config automatically.
