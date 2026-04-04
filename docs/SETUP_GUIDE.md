# 開発環境セットアップガイド

新しいコンピュータでこのプロジェクトの開発を始めるための完全ガイドです。

---

## 目次

- [macOS](#macos)
- [Windows](#windows)

---

# macOS

## Step 1: Homebrew のインストール

Homebrewは macOS 用のパッケージマネージャーです。

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

インストール後、ターミナルに表示される指示に従ってパスを設定してください：

```bash
# Apple Silicon (M1/M2/M3) の場合
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# Intel Mac の場合
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/usr/local/bin/brew shellenv)"
```

確認：

```bash
brew --version
# Homebrew 4.x.x
```

---

## Step 2: Git のインストール

```bash
brew install git
```

確認：

```bash
git --version
# git version 2.x.x
```

### Git の初期設定

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

---

## Step 3: Volta のインストール

Voltaは Node.js のバージョン管理ツールです。

```bash
curl https://get.volta.sh | bash
```

ターミナルを再起動するか、以下を実行：

```bash
source ~/.zshrc
```

確認：

```bash
volta --version
# 2.x.x
```

### Node.js と pnpm のインストール

```bash
volta install node@24
volta install pnpm@10
```

確認：

```bash
node -v
# v24.x.x

pnpm -v
# 10.x.x
```

---

## Step 4: Supabase アカウントの作成

1. [Supabase](https://supabase.com/) にアクセス
2. GitHubアカウントでサインアップ（推奨）または新規登録
3. 新しいプロジェクトを作成

### 接続情報の取得

1. Supabaseダッシュボードでプロジェクトを選択
2. **Project Settings** > **Database** に移動
3. **Connection string** セクションから以下をコピー：
   - **Transaction mode** (ポート6543) → `DATABASE_URL` 用
   - **Session mode** (ポート5432) → `DIRECT_URL` 用

---

## Step 5: Docker Desktop のインストール（オプション）

ローカルでPostgreSQLを使用したい場合のみ必要です。

### 方法1: Homebrew（推奨）

```bash
brew install --cask docker
```

### 方法2: 公式サイト

[Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/) からダウンロード

インストール後、Docker Desktop アプリを起動してください。

確認：

```bash
docker --version
# Docker version 27.x.x

docker compose version
# Docker Compose version v2.x.x
```

---

## Step 6: Cursor（エディタ）のインストール

### 方法1: Homebrew

```bash
brew install --cask cursor
```

### 方法2: 公式サイト

[Cursor](https://cursor.sh/) からダウンロード

### 推奨拡張機能

Cursorを起動後、以下の拡張機能をインストール：

1. **Biome** - リンター/フォーマッター
2. **Prisma** - Prismaスキーマのハイライト
3. **Tailwind CSS IntelliSense** - TailwindCSSの補完

---

## Step 7: プロジェクトのセットアップ

```bash
# 依存関係のインストール
pnpm install

# 環境変数の設定
cp .env.example .env
# .env ファイルを編集し、Supabaseの接続情報を設定

# Prismaクライアント生成
pnpm db:generate

# 開発サーバー起動
pnpm dev
```

🎉 [http://localhost:3000](http://localhost:3000) をブラウザで開いてください！

---

# Windows

## Step 1: Windows Terminal のインストール（推奨）

Microsoft Store から [Windows Terminal](https://aka.ms/terminal) をインストール

---

## Step 2: Git のインストール

### 方法1: winget（推奨）

PowerShell を**管理者として**実行：

```powershell
winget install Git.Git
```

### 方法2: 公式サイト

[Git for Windows](https://git-scm.com/download/win) からダウンロード

インストーラーはデフォルト設定のままでOKです。

**重要**: インストール後、PowerShell/ターミナルを再起動してください。

確認：

```powershell
git --version
# git version 2.x.x
```

### Git の初期設定

```powershell
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

---

## Step 3: Volta のインストール

### 方法1: winget（推奨）

```powershell
winget install Volta.Volta
```

### 方法2: 公式インストーラー

[Volta公式サイト](https://volta.sh/) から Windows インストーラーをダウンロード

**重要**: インストール後、PowerShell/ターミナルを再起動してください。

確認：

```powershell
volta --version
# 2.x.x
```

### Node.js と pnpm のインストール

```powershell
volta install node@24
volta install pnpm@10
```

確認：

```powershell
node -v
# v24.x.x

pnpm -v
# 10.x.x
```

---

## Step 4: Supabase アカウントの作成

1. [Supabase](https://supabase.com/) にアクセス
2. GitHubアカウントでサインアップ（推奨）または新規登録
3. 新しいプロジェクトを作成

### 接続情報の取得

1. Supabaseダッシュボードでプロジェクトを選択
2. **Project Settings** > **Database** に移動
3. **Connection string** セクションから以下をコピー：
   - **Transaction mode** (ポート6543) → `DATABASE_URL` 用
   - **Session mode** (ポート5432) → `DIRECT_URL` 用

---

## Step 5: Docker Desktop のインストール（オプション）

ローカルでPostgreSQLを使用したい場合のみ必要です。

### 前提条件: WSL2 の有効化

PowerShell を**管理者として**実行：

```powershell
wsl --install
```

コンピュータを再起動してください。

### Docker Desktop のインストール

#### 方法1: winget

```powershell
winget install Docker.DockerDesktop
```

#### 方法2: 公式サイト

[Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) からダウンロード

インストール後、Docker Desktop アプリを起動してください。

確認：

```powershell
docker --version
# Docker version 27.x.x

docker compose version
# Docker Compose version v2.x.x
```

---

## Step 6: Cursor（エディタ）のインストール

### 方法1: winget

```powershell
winget install Cursor.Cursor
```

### 方法2: 公式サイト

[Cursor](https://cursor.sh/) からダウンロード

### 推奨拡張機能

Cursorを起動後、以下の拡張機能をインストール：

1. **Biome** - リンター/フォーマッター
2. **Prisma** - Prismaスキーマのハイライト
3. **Tailwind CSS IntelliSense** - TailwindCSSの補完

---

## Step 7: プロジェクトのセットアップ

```powershell
# 依存関係のインストール
pnpm install

# 環境変数の設定
Copy-Item .env.example .env
# .env ファイルを編集し、Supabaseの接続情報を設定

# Prismaクライアント生成
pnpm db:generate

# 開発サーバー起動
pnpm dev
```

🎉 [http://localhost:3000](http://localhost:3000) をブラウザで開いてください！

---

# 共通: インストール確認チェックリスト

以下のコマンドが全て正常に実行できることを確認してください：

| コマンド | 期待される出力 | 必須 |
|---------|---------------|------|
| `git --version` | git version 2.x.x | ✅ |
| `volta --version` | 2.x.x | ✅ |
| `node -v` | v24.x.x | ✅ |
| `pnpm -v` | 10.x.x | ✅ |
| `docker --version` | Docker version 27.x.x | オプション |
| `docker compose version` | Docker Compose version v2.x.x | オプション |

> 💡 Docker はローカルでPostgreSQLを使用する場合のみ必要です。Supabaseを使用する場合は不要です。

---

# トラブルシューティング

## macOS

### `command not found: brew`

ターミナルを再起動するか、パスを再設定：

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

### `command not found: volta`

```bash
source ~/.zshrc
```

### Docker が起動しない

Docker Desktop アプリを手動で起動してください。

---

## Windows

### `volta: command not found`

1. PowerShell/ターミナルを再起動
2. それでも解決しない場合、環境変数にVoltaのパスが追加されているか確認

### Docker が起動しない

1. WSL2 が有効か確認: `wsl --status`
2. Docker Desktop アプリを手動で起動
3. Windowsを再起動

### `pnpm: command not found`

Voltaが正しくインストールされているか確認：

```powershell
volta list
```

---

# 次のステップ

セットアップが完了したら、[README.md](../README.md) を参照して開発を始めてください！

