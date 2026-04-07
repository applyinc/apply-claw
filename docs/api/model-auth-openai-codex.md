# Model Auth OpenAI Codex API

## 対象

- `GET /api/model-auth/openai-codex`
- `POST /api/model-auth/openai-codex`
- `POST /api/model-auth/openai-codex/login`
- `POST /api/model-auth/openai-codex/select`
- `POST /api/model-auth/openai-codex/disconnect`

## 概要

OpenClaw の既存 `openai-codex` OAuth / auth profile を Web UI から参照・切替するための API 群。

## 保存先

- `~/.openclaw-dench/openclaw.json`
- `~/.openclaw-dench/agents/main/agent/auth-profiles.json`

## GET `/api/model-auth/openai-codex`

### レスポンス

```json
{
  "provider": "openai-codex",
  "model": "openai-codex/gpt-5.4",
  "currentProfileId": "openai-codex:work",
  "profiles": [
    {
      "id": "openai-codex:work",
      "provider": "openai-codex",
      "label": "work",
      "accountId": "acct_123",
      "isCurrent": true
    }
  ]
}
```

## POST `/api/model-auth/openai-codex`

### 用途

- 固定モデル `openai-codex/gpt-5.4` を `openclaw.json` に反映する

## POST `/api/model-auth/openai-codex/login`

### 用途

- `openclaw models auth login --provider openai-codex --agent main` を実行する

### レスポンス

- 成功時は認証後の profile 一覧を返す
- 失敗時は `500` とエラーメッセージを返す

## POST `/api/model-auth/openai-codex/select`

### リクエスト

```json
{
  "profileId": "openai-codex:work"
}
```

### 用途

- `auth-profiles.json` の provider 順序を更新し、既定 account を切り替える

## POST `/api/model-auth/openai-codex/disconnect`

### リクエスト

```json
{
  "profileId": "openai-codex:work"
}
```

### 用途

- 指定 profile を `auth-profiles.json` から削除する
- 現在選択中 profile を削除した場合は残存 profile の先頭を既定にする
