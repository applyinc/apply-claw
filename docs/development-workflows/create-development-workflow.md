---
description: コマンド「docs/development-workflows のワークフローを作成する」
---

# docs/development-workflows/create-development-workflow.md

## 指示

{{ user_input }} を元に、docs/development-workflows のワークフローを作成してください

## 文脈情報

このドキュメントは、docs/development-workflows のワークフローを作成するためのガイドラインです。

## ルール

- ワークフローの作成手順のやり方をいちいち指示しなくても、「{{ user_input }} に合わせたワークフロー」を docs/development-workflows の中に、{{ workflow_name }}.md という名前で作成できること

## 手順

1. docs/development-workflows のワークフローを作成する場合、{{ user_input }} を要約して、ワークフロー名 {{ workflow_name }}.md を考えてください
2. タイトルのワークフロー名と {{ workflow_name }}.md のファイル名が良さそうか、ユーザに確認してください
3. 出力形式に合わせて、docs/development-workflows/{{ workflow_name }}.md を作成してください
4. {{ user_input }} の中に、出力形式の見出しと一致しない情報を追加したい場合、その見出しを追加して良いか、ユーザに確認してください
5. ユーザの追加見出しの確認がOKなら、"## 注意点" の上に、その見出しとその内容を追加してください

## 出力形式

- マークダウン形式で出力してください
- 作成するコマンドは、以下の構成にしてください
  - frontmatter
  - ## 指示
  - ## 文脈情報
  - ## ルール
  - (## 手順)
  - ## 出力形式
  - ## 入力データ
  - ## 入出力例 (Few-shots)
  - (## 注意点)

### 出力形式の例

```markdown
---
description: コマンド「〇〇する」
---

# docs/development-workflows/example-workflow.md

## 指示

〇〇してください

## 文脈情報

このドキュメントは、〇〇するためのガイドラインです。

## ルール

- ルール1
- ルール2

## 手順

1. 手順1
2. 手順2

## 出力形式

- マークダウン形式で出力してください

## 入力データ

入力データの説明

## 入出力例 (Few-shots)

例1:
入力: ...
出力: ...

## 注意点

- 分からない場合は、分からないとしてください
```
