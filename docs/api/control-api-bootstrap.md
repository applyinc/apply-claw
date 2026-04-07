ステータス: 作成中

# Control API Bootstrap

## 0. 概要

- エンドポイント: `GET /health`, `GET /version`, `GET /capabilities`, `GET /trpc/health`, `GET /trpc/version`, `GET /trpc/capabilities`
- 目的: control-api の疎通確認、基盤情報の確認、および Hono + tRPC 基盤の初期動作を提供する
- 関連画面: なし（インフラ/内部 API）
- 認証要否: `GET /health`, `GET /version`, `GET /capabilities` は不要。`/trpc/*` は `CONTROL_API_AUTH_TOKEN` が設定されている場合のみ Bearer token が必要

## 1. リクエスト

### パラメータ

- Path: なし
- Query: なし
- Body/Form: なし

### バリデーション

- なし

## 2. レスポンス

### 成功時

- HTTP ステータス: `200`
- 形式: JSON
- 例:

```json
{
  "status": "ok",
  "service": "control-api",
  "now": "2026-04-06T01:23:45.678Z"
}
```

`GET /version`:

```json
{
  "service": "control-api",
  "version": "0.1.0",
  "openclawVersion": "2026.4.2"
}
```

`GET /capabilities`:

```json
{
  "service": "control-api",
  "auth": {
    "enabled": true,
    "scheme": "bearer"
  },
  "transport": {
    "trpcPath": "/trpc",
    "healthPath": "/health",
    "versionPath": "/version",
    "capabilitiesPath": "/capabilities"
  },
  "features": {
    "gateway": true,
    "workspace": true,
    "modelAuth": true,
    "tasks": true
  }
}
```

### 失敗時

- HTTP ステータス: `401`, `5xx`
- エラーコード/メッセージ:
  - Bearer token 不備時は `401` / `UNAUTHORIZED`
  - 想定外エラー時は `500` / `INTERNAL_SERVER_ERROR`

## 3. 処理仕様

- `GET /health` は Hono route として疎通確認用の固定レスポンスを返す
- `GET /version` は control-api 自身の version と、解決できる場合は `openclaw` package version を返す
- `GET /capabilities` は auth 有効状態と提供予定 feature のブール値を返す
- `GET /trpc/health`, `GET /trpc/version`, `GET /trpc/capabilities` は tRPC router を通して同等情報を返す
- 両者のレスポンス schema は `packages/api-schema` で共通化する
- `CONTROL_API_AUTH_TOKEN` が設定されている場合、`/trpc/*` は `Authorization: Bearer <token>` を必須とする
- 全リクエストに `X-Control-Api-Request-Id` を付与し、JSON line 形式で request log を出力する

## 4. 認可・セキュリティ

- 認可条件:
  - 公開 endpoint は認証不要
  - `/trpc/*` は token 設定時のみ Bearer token 必須
- セキュリティ考慮:
  - CORS は `CONTROL_API_ALLOWED_ORIGIN` がある場合はその origin、なければ `*`
  - 内部エラー詳細はレスポンスに出さない

## 5. 依存データモデル

- 参照テーブル: なし
- 更新テーブル: なし

## 6. 非機能要件

- レイテンシ目標: 同一リージョン内で `100ms` 未満
- ログ/監査:
  - 起動ログに bind host / port を出力する
  - request log に `requestId`, `method`, `path`, `status`, `durationMs` を含める

## 7. 受け入れ基準（Acceptance Criteria）

- [ ] `apps/control-api` が単体で起動できる
- [ ] `GET /health` が JSON を返す
- [ ] `GET /version` と `GET /capabilities` が JSON を返す
- [ ] `GET /trpc/health`, `GET /trpc/version`, `GET /trpc/capabilities` が schema 通りに動く
- [ ] `CONTROL_API_AUTH_TOKEN` 設定時に `/trpc/*` が token なしで `401` を返す

## 8. 未決事項

- `gateway`, `workspace`, `model-auth`, `tasks` の各 feature をいつ本当に `true` に切り替えるか
