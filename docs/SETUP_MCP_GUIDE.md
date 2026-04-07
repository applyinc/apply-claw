# MCP（Model Context Protocol）セットアップガイド

CursorでGitHub MCPとGoogle Workspace MCPを有効にするためのガイドです。

---

## 目次

- [前提条件](#前提条件)
- [Step 1: 必要なツールのインストール](#step-1-必要なツールのインストール)
- [Step 2: GitHub CLI の認証](#step-2-github-cli-の認証)
- [Step 3: GCP 認証情報ファイルの取得と配置](#step-3-gcp-認証情報ファイルの取得と配置)
- [Step 4: Cursor の再起動と Google 認証](#step-4-cursor-の再起動と-google-認証)
- [動作確認](#動作確認)
- [トラブルシューティング](#トラブルシューティング)

---

## 前提条件

- Cursor がインストール済みであること
- Homebrew（macOS）または winget（Windows）が使用可能であること
- リポジトリを clone 済みであること

> 💡 MCP設定ファイル（`.cursor/mcp.json`）はリポジトリに含まれているため、個別に作成する必要はありません。OS（macOS/Linux/Windows）は自動判定されます。

---

## Step 1: 必要なツールのインストール

以下の2つのツールをインストールします。

### 1.1 GitHub CLI（`gh`）

GitHub MCP が使用します。

#### macOS

```bash
brew install gh
```

#### Windows

```powershell
winget install GitHub.cli
```

### 1.2 uv（`uvx` コマンド）

Google Workspace MCP が使用します。

#### macOS

```bash
brew install uv
```

#### Windows

```powershell
winget install astral-sh.uv
```

### インストール確認

```bash
gh --version      # gh version 2.x.x
uvx --version     # uvx 0.x.x
```

---

## Step 2: GitHub CLI の認証

```bash
gh auth login
```

対話形式で以下を選択：
1. `GitHub.com`
2. `SSH`（推奨）または `HTTPS`
3. `Login with a web browser`

確認：

```bash
gh auth status
# ✓ Logged in to github.com as your-username
```

---

## Step 3: GCP 認証情報ファイルの取得と配置

Google Workspace MCP を使用するには、GCP（Google Cloud Platform）の OAuth 認証情報ファイルが必要です。

### 管理者から認証情報ファイルを取得

プロジェクト管理者に連絡し、`gcp-oauth.keys.json` ファイルを受け取ってください。

### 認証情報ファイルの配置

受け取ったファイルをプロジェクトに配置します：

```bash
# ディレクトリ作成（存在しない場合）
mkdir -p .mcp-credentials

# 受け取ったファイルを配置
mv ~/Downloads/gcp-oauth.keys.json .mcp-credentials/gcp-oauth.keys.json
```

> ⚠️ `.mcp-credentials/` は `.gitignore` に含まれており、リポジトリにコミットされません。**このファイルは安全に管理してください。**

---

## Step 4: Cursor の再起動と Google 認証

### 4.1 Cursor の再起動

MCP設定を反映するため、Cursorを完全に終了して再起動してください。

### 4.2 Google Workspace の認証

Cursorのチャットで Google Workspace MCP を使用するコマンドを実行すると、認証URLが表示されます：

1. チャットで「Google Driveのファイル一覧を取得して」と入力
2. 表示された認証URLをクリック
3. **自分のGoogleアカウント**でログイン
4. 「このアプリはGoogleで確認されていません」と表示された場合：
   - **「詳細」** をクリック
   - **「〇〇（安全でないページ）に移動」** をクリック
5. 必要な権限を許可
6. 認証完了後、再度コマンドを実行

> 📝 認証情報は `~/.google_workspace_mcp/credentials/` に保存されます（各ユーザー固有）。

---

## 動作確認

### GitHub MCP

Cursorのチャットで以下を試してください：

```
GitHubのリポジトリ一覧を取得して
```

成功すると、あなたのGitHubリポジトリ一覧が表示されます。

### Google Workspace MCP

```
Google Driveで「プロジェクト」を検索して
```

成功すると、Google Drive内の検索結果が表示されます。

---

## トラブルシューティング

### `gh: command not found`

GitHub CLI がインストールされていません。[Step 1.1](#11-github-cligh) を参照してください。

### `uvx: command not found`

`uv` がインストールされていません。[Step 1.2](#12-uvuvx-コマンド) を参照してください。

### GitHub MCP: 認証エラー

```bash
# 認証状態を確認
gh auth status

# 再認証
gh auth login
```

### Google Workspace MCP: API が有効になっていない

以下のようなエラーが出る場合：

```
Google Docs API has not been used in project XXXXX before or it is disabled.
```

管理者に連絡して、該当するAPIを有効化してもらってください。

### Google Workspace MCP: 認証URLが表示されるが認証できない

1. 認証URLをブラウザで開く
2. 自分のGoogleアカウントでログイン
3. 「このアプリはGoogleで確認されていません」と表示された場合：
   - **「詳細」** をクリック
   - **「〇〇（安全でないページ）に移動」** をクリック
4. すべての権限を許可

### MCP が Cursor に表示されない

1. `.cursor/mcp.json` がプロジェクトルートに存在することを確認
2. Cursorを完全に終了して再起動

### Windows: `node: command not found`

Node.js がインストールされていないか、PATH に含まれていません。Node.js をインストールしてください：

```powershell
winget install OpenJS.NodeJS.LTS
```

インストール後、新しいターミナルを開いて確認：

```powershell
node --version
```

---

## 参考リンク

- [Model Context Protocol (MCP) 公式ドキュメント](https://modelcontextprotocol.io/)
- [GitHub MCP Server](https://github.com/modelcontextprotocol/servers/tree/main/src/github)
- [Google Workspace MCP](https://github.com/aaronsb/google-workspace-mcp)

---

## 次のステップ

MCPのセットアップが完了したら、Cursorのチャットで以下のような操作が可能になります：

- GitHubのIssue/PRの作成・管理
- Google Driveのファイル検索・閲覧
- Google Docsの内容読み取り
- その他のGoogle Workspaceサービスとの連携
