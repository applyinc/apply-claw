---
description: コマンド「コミット積み上げ戦略（add戦略特化）」
---

# docs/development-workflows/create-git-commits.md

## 指示

大規模な変更を依存関係と抽象度を考慮して段階的にgit addし、適切な粒度でコミットを積み上げてください。

コミットする時は、`docs/development-workflows/create-git-commit.md` を参照してコミットしてください

## 文脈情報

このワークフローは、機能追加やリファクタリングで大量のファイル変更が発生した際に、依存関係を守りながら段階的にgit addしてコミットするためのガイドラインです。
実装が終わり、git diff で全ての変更で確認できます。

## ルール

- **依存関係の順序を必ず守ること（上位層 → 下位層）**
- **抽象度レベル: `docs/ > src/lib/ > src/components/ > src/app/`**
  - この順序は厳格に遵守し、前の層が完了してから次の層に進むこと
- ページ単位では必ず分離し、URL・機能を明示すること
- コミットメッセージは `docs/development-workflows/create-git-commit.md` を参照

## 手順

### 1. 変更分析

1. `git diff --staged --name-status` でステージングされているファイルがある場合、`git restore --staged .` で add を戻す
2. `git status --short --untracked-files` で全変更確認
3. 削除(D)・新規(??)・変更(M)・移動(R)・追加(A)を分類
4. 依存関係とディレクトリ階層でグルーピング

### 2. 段階的git add戦略

#### フェーズ1: 前処理

```bash
# 1. 削除系ファイルの処理
git status --short --untracked-files | grep "^ D"
git add -u <削除対象ファイル>
# → create-git-commit.md 参照してコミット

# 2. 単純な変更（rename, typo, move, format, comment, import整理）
git add <リネーム対象ファイル>
# → create-git-commit.md 参照してコミット
```

#### フェーズ2: ドキュメント・設定

```bash
# 1. ドキュメント更新
git add docs/
# → create-git-commit.md 参照してコミット

# 2. 設定ファイル
git add .vscode/ biome.json vitest.config.ts package.json
# → create-git-commit.md 参照してコミット
```

#### フェーズ3: ライブラリ層

```bash
# ユーティリティ・共通ライブラリ
git add src/lib/
# → create-git-commit.md 参照してコミット
```

#### フェーズ4: コンポーネント層

```bash
# UIコンポーネント
git add src/components/
# → create-git-commit.md 参照してコミット
```

#### フェーズ5: ページ層

```bash
# ページ別実装（URL明示）
git add src/app/page.tsx
# → create-git-commit.md 参照してコミット
# 結果例:
# feat(page): ホームページ / 実装
```

## 出力形式

各git addの後、`docs/development-workflows/create-git-commit.md` を参照してコミット

## 入力データ

git status --short --untracked-files の出力結果

## 入出力例 (Few-shots)

**例1: 新機能実装**
```bash
# 入力: git status で大量の変更

# 出力: 段階的add戦略とコミット
git add src/lib/utils.ts
# → create-git-commit.md 参照してコミット
# 結果例:
# feat(lib): ユーティリティ関数追加

git add src/components/ui/
# → create-git-commit.md 参照してコミット
# 結果例:
# feat(ui): ボタンコンポーネント追加

git add src/app/dashboard/page.tsx
# → create-git-commit.md 参照してコミット
# 結果例:
# feat(page): ダッシュボードページ /dashboard 実装
```

## 注意点

- 出力は日本語で
- 分からない場合は、分からないとしてください
- 必ず依存関係順序を守ること
- 各addでテスト（pnpm test）が通ることを確認
- ステージングの追加で問題が起きて解決が困難だと判断したら、`git restore --staged .` で戻してやり直してください
- ページは必ずURL付きで分離
