ステータス: 作成中

# Control API Filesystem

## 0. 概要

- エンドポイント:
  - `GET /workspace/file`
  - `POST /workspace/file`
  - `DELETE /workspace/file`
  - `GET /workspace/raw-file`
  - `POST /workspace/raw-file`
  - `POST /workspace/upload`
  - `GET /workspace/assets/*`
  - `POST /workspace/mkdir`
  - `POST /workspace/move`
  - `POST /workspace/rename`
  - `POST /workspace/copy`
  - `POST /workspace/delete`
  - `POST /workspace/init`
- 目的: workspace 配下のテキストファイル・バイナリファイル・アップロード資産へのアクセスを control-api に集約する
- 関連画面: `workspace.md`
- 認証要否: 要

## 1. リクエスト

### パラメータ

- `GET /workspace/file?path=<relative-path>`
- `POST /workspace/file`

```json
{
  "path": "notes/today.md",
  "content": "# hello"
}
```

- `DELETE /workspace/file`

```json
{
  "path": "notes/today.md"
}
```

- `GET /workspace/raw-file?path=<path>`
- `POST /workspace/raw-file?path=<path>`
  - body: binary
- `POST /workspace/upload`
  - body: multipart form-data (`file`)
- `GET /workspace/assets/<asset-path>`
- `POST /workspace/mkdir`

```json
{
  "path": "notes/archive",
  "absolute": false
}
```

- `POST /workspace/move`

```json
{
  "sourcePath": "notes/today.md",
  "destinationDir": "notes/archive"
}
```

- `POST /workspace/rename`

```json
{
  "path": "notes/today.md",
  "newName": "yesterday.md"
}
```

- `POST /workspace/copy`

```json
{
  "path": "notes/today.md",
  "destinationPath": "notes/today copy.md"
}
```

- `POST /workspace/delete`

```json
{
  "workspace": "sandbox"
}
```

- `POST /workspace/init`

```json
{
  "workspace": "sandbox",
  "seedBootstrap": true
}
```

### バリデーション

- workspace 内の protected system file は write/delete 不可
- upload は 25MB 以下
- `assets/*` は画像系拡張子のみ配信

## 2. レスポンス

### 成功時

- HTTP ステータス: `200`
- `GET /workspace/file`

```json
{
  "content": "# hello",
  "type": "markdown"
}
```

- `POST /workspace/file`, `DELETE /workspace/file`, `POST /workspace/raw-file`
- `POST /workspace/mkdir`

```json
{
  "ok": true,
  "path": "notes/today.md"
}
```

- `POST /workspace/move`, `POST /workspace/rename`, `POST /workspace/copy`

```json
{
  "ok": true,
  "newPath": "notes/archive/today.md"
}
```

- `POST /workspace/delete`

```json
{
  "deleted": true,
  "workspace": "sandbox",
  "activeWorkspace": "default",
  "workspaceRoot": "/Users/example/.openclaw-dench/workspace"
}
```

- `POST /workspace/init`

```json
{
  "workspace": "sandbox",
  "activeWorkspace": "sandbox",
  "workspaceDir": "/Users/example/.openclaw-dench/workspace-sandbox",
  "stateDir": "/Users/example/.openclaw-dench",
  "seededFiles": [
    "AGENTS.md"
  ],
  "workspaceRoot": "/Users/example/.openclaw-dench/workspace-sandbox"
}
```

- `POST /workspace/upload`

```json
{
  "ok": true,
  "path": "assets/1712360000000-screenshot.png"
}
```

- `GET /workspace/raw-file`, `GET /workspace/assets/*`
  - file body を返す
  - `Content-Type` と `Cache-Control` を付与する

### 失敗時

- HTTP ステータス: `400`, `403`, `404`, `409`, `500`
- エラーコード/メッセージ:
  - `400`: path / body / form-data 不正
  - `403`: protected system file への書き込み・削除
  - `404`: ファイル未存在
  - `409`: 既存 destination / 既存 workspace / delete 不可状態
  - `500`: 読み書き失敗

## 3. 処理仕様

- text file API は workspace root を基準に安全に path 解決する
- raw-file API は absolute path / workspace-relative path の両方を扱う
- upload は workspace の `assets/` 配下へ保存する
- assets API は immutable cache header で画像を返す
- mkdir / move / rename / copy は workspace 内の安全な path 解決を通して実行する
- workspace init / delete は state dir 配下の workspace ディレクトリと UI state を更新する
- `apps/web` 側はこれら endpoint への proxy として動く

## 4. 認可・セキュリティ

- 認可条件: `Authorization: Bearer <CONTROL_API_AUTH_TOKEN>`
- セキュリティ考慮:
  - path traversal を拒否する
  - `.object.yaml`, `workspace.duckdb`, `workspace_context.yaml` などは保護する
  - binary 配信は MIME allowlist に従う

## 5. 依存データモデル

- 参照ファイル: workspace 配下の各ファイル
- 更新ファイル: workspace 配下の各ファイル

## 6. 非機能要件

- レイテンシ目標: 通常ファイルで `200ms` 未満
- ログ/監査:
  - request log に request id を含める
  - upload / delete は将来的に監査ログ対象

## 7. 受け入れ基準（Acceptance Criteria）

- [ ] text file read/write/delete が control-api 経由で動く
- [ ] raw-file read/write が control-api 経由で動く
- [ ] upload が control-api 経由で動く
- [ ] assets 配信が control-api 経由で動く
- [ ] mkdir / move / rename / copy が control-api 経由で動く
- [ ] workspace init / delete が control-api 経由で動く

## 8. 未決事項

- absolute path 読み取りをどこまで許容するか
