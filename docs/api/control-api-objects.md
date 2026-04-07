# control-api Objects API

## 概要

workspace の object 系 API を `apps/control-api` に集約する。
`apps/web` 側の `objects/*` route は control-api の thin proxy として動作する。

## 関連画面

- `/workspace`

## 対象エンドポイント

### Object detail / views

- `GET /workspace/objects/:name`
- `GET /workspace/objects/:name/views`
- `PUT /workspace/objects/:name/views`
- `PATCH /workspace/objects/:name/display-field`

### Field operations

- `PATCH /workspace/objects/:name/fields/reorder`
- `POST /workspace/objects/:name/fields`
- `PATCH /workspace/objects/:name/fields/:fieldId`
- `DELETE /workspace/objects/:name/fields/:fieldId`
- `PATCH /workspace/objects/:name/fields/:fieldId/enum-rename`

### Entry operations

- `GET /workspace/objects/:name/entries/options`
- `POST /workspace/objects/:name/entries`
- `GET /workspace/objects/:name/entries/:id`
- `PATCH /workspace/objects/:name/entries/:id`
- `DELETE /workspace/objects/:name/entries/:id`
- `GET /workspace/objects/:name/entries/:id/content`
- `PUT /workspace/objects/:name/entries/:id/content`
- `POST /workspace/objects/:name/entries/bulk-delete`

### Action operations

- `POST /workspace/objects/:name/actions`
- `GET /workspace/objects/:name/actions/runs`

## メモ

- object detail は object metadata / fields / statuses / entries / saved views をまとめて返す。
- action 実行は SSE をそのまま返し、run 完了時に `action_runs` テーブルへ best-effort で記録する。
- entry content は object directory 配下の Markdown と `documents.entry_id` の両方を見て解決する。
