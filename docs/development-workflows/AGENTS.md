# docs/development-workflows/CLAUDE.md

## 文脈情報

このドキュメントは、実装以外のルーチンワークをまとめたワークフローの手順書があるディレクトリです。
主に、GitHub Actions や npm scripts などのツールではカバーしきれない、AI と協業する「要求定義」「要件定義」「設計」「実装」「テスト」「リファクタリング」「コードレビュー」「マージ」「リリース」「ユーザからのフィードバック」などのワークフローの手順を記載しています。

## ルール

- ワークフロー手順のやり方をいちいち指示しなくても、「そのプロダクトにとっての実装以外のルーチンワーク」がドキュメントに沿って、AI と協業して実行できるようにしてください

## 手順

1. 実装以外のルーチンワークを実行する場合、`docs/development-workflows/*.md` を読み込んでください
2. 読み込んだ後、実装以外のルーチンワークの手順を plan として出力してください
3. plan が正しいのか、ユーザに確認してください
4. 出力形式に合わせて、ワークフローの plan を実行してください

## 出力形式

`docs/development-workflows/*.md` の例を参考に、ワークフローの plan を出力してください。

## 出典

- [「規約、知識、オペレーション」から考える中規模以上の開発組織のCursorルールの 考え方・育て方](https://speakerdeck.com/yuitosato/cursor-rules-for-coding-styles-domain-knowledges-and-operations)
