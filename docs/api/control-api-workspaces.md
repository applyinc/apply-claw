ステータス: 作成中

# Control API Workspaces

## 0. 概要

- エンドポイント: `GET /workspace/list`, `GET /workspace/active-model`, `POST /workspace/switch`, `trpc.workspace.list`, `trpc.workspace.activeModel`, `trpc.workspace.switch`
- 目的: OpenClaw state dir 上の workspace 一覧、現在モデル、active workspace 切替を control-api に集約する
- 関連画面: `workspace.md`
- 認証要否: 要

## 1. リクエスト

### パラメータ

- `GET /workspace/list`: なし
- `GET /workspace/active-model`: なし
- `POST /workspace/switch`
  - Body:

```json
{
  "workspace": "default"
}
```

### バリデーション

- `workspace` は英数字、ハイフン、アンダースコアのみ
- 存在しない workspace には切替できない

## 2. レスポンス

### 成功時

- HTTP ステータス: `200`
- 形式: JSON

`GET /workspace/list`:

```json
{
  "activeWorkspace": "default",
  "workspaces": [
    {
      "name": "default",
      "stateDir": "/Users/example/.openclaw-dench",
      "workspaceDir": "/Users/example/.openclaw-dench/workspace",
      "isActive": true,
      "hasConfig": true,
      "gateway": {
        "mode": "local",
        "port": 19001,
        "url": "ws://127.0.0.1:19001"
      }
    }
  ]
}
```

`GET /workspace/active-model`:

```json
{
  "model": "openai-codex/gpt-5.4"
}
```

`POST /workspace/switch`:

```json
{
  "activeWorkspace": "default",
  "stateDir": "/Users/example/.openclaw-dench",
  "workspaceRoot": "/Users/example/.openclaw-dench/workspace",
  "workspace": {
    "name": "default",
    "stateDir": "/Users/example/.openclaw-dench",
    "workspaceDir": "/Users/example/.openclaw-dench/workspace",
    "isActive": true,
    "hasConfig": true,
    "gateway": {
      "mode": "local",
      "port": 19001,
      "url": "ws://127.0.0.1:19001"
    }
  }
}
```

### 失敗時

- HTTP ステータス: `400`, `401`, `404`, `500`
- エラーコード/メッセージ:
  - `400`: workspace 名が不正
  - `401`: Bearer token 不備
  - `404`: workspace が存在しない
  - `500`: 予期しない内部エラー

## 3. 処理仕様

- workspace 一覧は `OPENCLAW_STATE_DIR` 配下の `workspace` と `workspace-*` ディレクトリを走査して返す
- active workspace は `.dench-ui-state.json` を優先して解決する
- active model は `openclaw.json` の `agents.defaults.model.primary` を返す
- workspace 切替時は `.dench-ui-state.json` と `openclaw.json` の default agent 設定を更新する
- Hono の REST endpoint と tRPC procedure は同じ service 実装を利用する

## 4. 認可・セキュリティ

- 認可条件: `Authorization: Bearer <CONTROL_API_AUTH_TOKEN>`
- セキュリティ考慮:
  - state dir 実パスを返すため、control-api は信頼済み caller に限定する
  - workspace 切替は write 操作として監査対象にする

## 5. 依存データモデル

- 参照ファイル:
  - `~/.openclaw-dench/openclaw.json`
  - `~/.openclaw-dench/.dench-ui-state.json`
- 更新ファイル:
  - `~/.openclaw-dench/openclaw.json`
  - `~/.openclaw-dench/.dench-ui-state.json`

## 6. 非機能要件

- レイテンシ目標: `200ms` 未満
- ログ/監査:
  - request log に request id を含める
  - workspace 切替の監査ログ詳細は今後追加

## 7. 受け入れ基準（Acceptance Criteria）

- [ ] `GET /workspace/list` で active workspace と一覧が返る
- [ ] `GET /workspace/active-model` で現在モデルが返る
- [ ] `POST /workspace/switch` で active workspace を更新できる
- [ ] 同機能が `trpc.workspace.*` からも利用できる

## 8. 未決事項

- workspace 切替イベントを telemetry / audit log にどう統一するか
