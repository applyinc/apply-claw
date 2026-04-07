ステータス: 作成中

# Workspace

## 0. 概要

- 機能名: ワークスペース
- 画面 URL: `/`
- 対象ユーザー: ワークスペース利用者
- 概要（50字程度）: チャット、ファイル、ワークスペース設定を操作するメイン画面
- 優先度: Must
- 関連リンク（Figma / チケット / PR）:

## 1. 目的（WHY）

### 課題

- メイン画面からモデル認証状態を確認できても、OpenAI Codex の OAuth アカウント切替導線がなかった。

### 目標

- ユーザーがメイン画面の左下モデル表示から OpenAI Codex の認証状態を確認し、OAuth ログインとアカウント切替を行える。

## 2. できるようにしたい体験（ユーザーストーリー）

- ユーザーは左下のモデル名をクリックして OpenAI Account ダイアログを開ける。
- ユーザーは `Sign in with OpenAI` から OpenClaw の既存 OAuth フローを開始できる。
- ユーザーは接続済みアカウント一覧から使用する OpenAI Codex アカウントを切り替えできる。

## 3. 今回の範囲

### Must（必須事項）

- 左下モデル表示のクリック導線
- OpenAI Codex アカウント一覧の表示
- OpenAI Codex OAuth ログイン
- アカウント切替
- アカウント切断

### Won't（今回はやらない）

- Anthropic など他 provider の認証切替
- モデル ID 自体の変更

## 4. 対象画面・操作（WHAT）

### 表示要素

- 左下モデル表示
- `OpenAI Account` ダイアログ
- 接続済みアカウント一覧
- `Sign in with OpenAI` ボタン

### 操作仕様

#### OpenAI Account ダイアログを開く

- ユーザーは左下のモデル名をクリックして `OpenAI Account` ダイアログを開ける。
- ダイアログでは固定モデル `openai-codex/gpt-5.4` と接続済みアカウント一覧を確認できる。

#### OpenAI Codex へログインする

- ユーザーは `Sign in with OpenAI` を押して OpenClaw の既存 `models auth login --provider openai-codex` フローを開始できる。
- ログインに成功すると、新しいアカウントが一覧に追加され、既定アカウントとして選択される。

#### 使用アカウントを切り替える

- ユーザーは接続済みアカウントの `Use this account` を押して、既定の OpenAI Codex アカウントを切り替えできる。
- 切替に成功すると、選択したアカウントが `Current` として表示される。

#### アカウントを切断する

- ユーザーは接続済みアカウントの `Disconnect` を押して、そのアカウントを一覧から削除できる。
- 現在のアカウントを削除した場合、残りがあれば先頭アカウントが既定に切り替わる。

## 5. デザイン

- 参照 Figma:
- 注記: 実装時は最新デザインを優先

## 6. 権限・ロール

- アクセス可能ロール: 未定義
- ロールごとの表示/操作差分: 現時点では未実装

## 7. データモデル・保存仕様

- 参照ファイル: `~/.openclaw-dench/openclaw.json`, `~/.openclaw-dench/agents/main/agent/auth-profiles.json`
- 主な表示項目: `agents.defaults.model.primary`, `profiles[*].provider`, `profiles[*].accountId`
- 更新対象項目: `agents.defaults.model.primary`, `auth.order`, `profiles`

## 8. API 契約

- 画面が利用する API:
  - `GET /api/model-auth/openai-codex`
  - `POST /api/model-auth/openai-codex/login`
  - `POST /api/model-auth/openai-codex/select`
  - `POST /api/model-auth/openai-codex/disconnect`
- リクエスト: JSON で `profileId` を送信する
- レスポンス: provider, model, currentProfileId, profiles を返す

## 9. バリデーション・エラーハンドリング

- 入力バリデーション: 切替/切断時は `profileId` 必須
- エラーメッセージ: CLI 実行失敗や profile 未検出時はダイアログ内に表示する
- 失敗時の復帰方法: ユーザーはダイアログを閉じずに再実行できる

## 10. 非機能要件

- パフォーマンス: ダイアログ表示時に都度認証状態を再取得する
- セキュリティ: OAuth トークン本体は UI に返さない
- 監査/ログ: 現時点では画面側の監査ログ実装なし

## 11. 受け入れ基準（Acceptance Criteria）

- [ ] 左下のモデル名クリックで `OpenAI Account` ダイアログを開ける
- [ ] `Sign in with OpenAI` で OpenClaw の OpenAI Codex OAuth を開始できる
- [ ] 接続済みアカウントを切り替えできる
- [ ] 接続済みアカウントを切断できる

## 12. リリース・運用メモ

- マイグレーション有無: なし
- feature flag: なし
- 運用時注意点: ログインフローはローカル環境で `openclaw` CLI が PATH にある前提

## 13. 未決事項

- `openclaw models auth login` が headless 環境でブラウザ起動に失敗した場合の UX 改善
