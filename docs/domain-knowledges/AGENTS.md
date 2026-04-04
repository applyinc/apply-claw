# docs/domain-knowledges/CLAUDE.md

## 文脈情報

このドキュメントは、ドメイン知識、コンテキスト、機能別の情報をまとめた資料があるディレクトリです。
主に、README.md や タスク管理ツールなどに存在する「仕様書」、「ドメインモデル図」、「用語集」、「ユースケース図」といった「図式」など、開発前のキャッチアップとして必要な文脈、背景、仕様を記載しています。

## ルール

- What (実装の要件) をいちいち指示しなくても、「そのプロダクトのコンテキストにあったコード」を出力してください

## 手順

1. コードを作成・変更する場合、`docs/domain-knowledges/**/*.md` を読み込んでください
2. 読み込んだ後、開発前のキャッチアップとして必要な「文脈」、「背景」、「仕様」を理解してください。
3. 読み込んだ「文脈」と、実際のコードとコメントで書かれていることが異なる場合、コードとコメントを正としてください
4. 出力形式に合わせて、コードを作成してください
5. コードとコメントに合わせて、リバースナレッジで `docs/domain-knowledges/**/*.md` を更新してください

## 出力形式

`docs/domain-knowledges/**/*.md` ドメイン知識の「ドメイン知識」、「コンテキスト」、「機能別の情報」を満たすように、コードを出力してください

## ディレクトリ構成例

```
/docs
  /domain-knowledges
    /auth
      /authentication-flow.md  # 認証フロー
    /database
      /data-structure.md       # データ構造
    /api
      /endpoints.md            # APIエンドポイント
```

## 出典

- [「規約、知識、オペレーション」から考える中規模以上の開発組織のCursorルールの 考え方・育て方](https://speakerdeck.com/yuitosato/cursor-rules-for-coding-styles-domain-knowledges-and-operations)
