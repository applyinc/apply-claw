# API 仕様書

このディレクトリでは、管理画面が利用する API の契約を Markdown で管理する。

## ルール

- 1 API（または 1 エンドポイント群）1 ファイル。
- 新規 API 追加時は `docs/api/_templates/api-spec-template.md` をコピーして作成する。
- 画面仕様との対応は「関連画面」に必ず記載する。

## 一覧

- `control-api-bootstrap.md`: control-api の Hono + tRPC 起動面と health endpoint
- `control-api-filesystem.md`: control-api の text file / binary file / assets / upload / file operation / workspace init-delete API
- `control-api-objects.md`: control-api の object detail / field / entry / action API
- `control-api-workspace-explorer.md`: control-api の tree / search / query / virtual file / watch API
- `control-api-workspaces.md`: control-api の workspace 一覧取得・active model 取得・workspace 切替 API
- `model-auth-openai-codex.md`: OpenAI Codex の OAuth アカウント一覧・ログイン・切替・切断 API
