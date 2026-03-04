# DenchClaw OAuth (OpenClaw plugin)

OAuth provider plugin for DenchClaw-hosted models.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable denchclaw-auth
```

Restart the Gateway after enabling.

## Authenticate

Set at least a client id, then run provider login:

```bash
export DENCHCLAW_OAUTH_CLIENT_ID="<your-client-id>"
openclaw models auth login --provider denchclaw --set-default
```

## Optional env vars

- `DENCHCLAW_OAUTH_CLIENT_SECRET`
- `DENCHCLAW_OAUTH_AUTH_URL` (default: `https://auth.denchclaw.ai/oauth/authorize`)
- `DENCHCLAW_OAUTH_TOKEN_URL` (default: `https://auth.denchclaw.ai/oauth/token`)
- `DENCHCLAW_OAUTH_REDIRECT_URI` (default: `http://127.0.0.1:47089/oauth/callback`)
- `DENCHCLAW_OAUTH_SCOPES` (space/comma separated)
- `DENCHCLAW_OAUTH_USERINFO_URL` (optional for email display)
- `DENCHCLAW_PROVIDER_BASE_URL` (default: `https://api.denchclaw.ai/v1`)
- `DENCHCLAW_PROVIDER_MODEL_IDS` (space/comma separated, default: `chat`)
- `DENCHCLAW_PROVIDER_DEFAULT_MODEL` (default: first model id)

## Notes

- This plugin configures `models.providers.denchclaw` as `openai-completions`.
- OAuth tokens are stored in auth profiles and the provider is patched into config automatically.
