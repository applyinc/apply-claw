ステータス: 作成中

# Control API Workspace Explorer

## 0. 概要

- エンドポイント:
  - `GET /workspace/tree`
  - `GET /workspace/context`
  - `GET /workspace/search-index`
  - `GET /workspace/suggest-files`
  - `GET /workspace/path-info`
  - `GET /workspace/link-preview`
  - `POST /workspace/query`
  - `POST /workspace/execute`
  - `POST /workspace/reports/execute`
  - `GET /workspace/db/introspect`
  - `POST /workspace/db/query`
  - `POST /workspace/write-binary`
  - `GET /workspace/virtual-file`
  - `POST /workspace/virtual-file`
  - `GET /workspace/watch`
- 目的: workspace の tree / search / context / db query / virtual file / watch を control-api に集約する
- 関連画面: `workspace.md`
- 認証要否: 要

## 1. 処理仕様

- `tree`
  - workspace ディレクトリを再帰走査し、object / document / app / database を識別する
  - `~skills/...` の virtual node も返す
- `context`
  - `workspace_context.yaml` の簡易構造を JSON 化する
- `search-index`
  - file/object/entry をまとめて検索用 index として返す
- `suggest-files`
  - browse mode と search mode を 1 endpoint で扱う
- `query`, `execute`, `db/query`, `db/introspect`
  - DuckDB CLI を使って read-only query / introspection を行う
- `reports/execute`
  - report filter を SQL に差し込んで read-only query を実行する
- `link-preview`
  - 外部 URL を fetch して title / description / image / favicon を抽出する
- `virtual-file`
  - `~skills/*/SKILL.md`, `~memories/*`, `~workspace/*` を安全な実ファイルへ解決する
- `watch`
  - chokidar の polling mode で SSE を返す

## 2. レスポンス方針

- 成功時: `200`
- 失敗時: `400`, `403`, `404`, `500`
- `watch` は `text/event-stream`
- `write-binary` は `{ ok, path }`

## 3. 備考

- `open-file` と `thumbnail` はローカル GUI / macOS Quick Look 依存のため、まだ web 側 local route に残す
- `objects/*` は未移行
