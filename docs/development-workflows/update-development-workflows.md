---
description: コマンド「development-workflows配下の複数の既存ワークフローを適切に更新する」
---

# docs/development-workflows/update-development-workflows.md

## 指示

{{ user_input }} を元に、該当する docs/development-workflows/ 配下の複数のワークフローを更新してください

## 文脈情報

このドキュメントは、docs/development-workflows/ 配下の複数の既存ワークフローを更新するためのガイドラインです。

## ルール

- 対話を元に、該当する docs/development-workflows/ 配下の複数のワークフローを更新してください
- 既存ワークフローの構造と形式を維持すること
- frontmatterやコメントブロックなどの既存の書式を保持すること

## 手順

1. docs/development-workflows/ 配下の複数のワークフローを更新する場合、
2. 更新対象は、docs/development-workflows/ 配下の md ファイル全てで、その中から、該当するワークフローを特定する
3. 対話して、{{ user_input }} を取得する
4. {{ user_input }} を元に、複数ある docs/development-workflows/ 配下のワークフローのうち、どのワークフローを更新するかを決定する
5. 更新対象のワークフローの内容を読み込み、現在の構造と形式を把握する
6. {{ user_input }} の内容に基づいて、適切な更新内容を決定する
7. 更新対象のワークフローのどの部分をどのように更新するか、ユーザに確認する
8. ユーザの確認後、更新対象のワークフローを更新する

## 出力形式

- マークダウン形式で出力してください

## 入力データ

更新したいワークフローのファイルパスまたは内容、および更新内容の詳細

## 入出力例 (Few-shots)

例1:
入力:
```
docs/development-workflows/create-git-commit.md のコミットタイプに「deps」を追加したい。
「依存関係の更新」という説明で
```

出力:
```
更新対象: docs/development-workflows/create-git-commit.md
更新内容:
- ### タイプ（Type）セクションの「その他」カテゴリに以下を追加:
  - `deps`: 依存関係の更新

この内容で更新してよろしいですか？
```

## 注意点

- 更新対象は、docs/development-workflows/ 配下の md ファイル全てです
- 分からない場合は、分からないとしてください
