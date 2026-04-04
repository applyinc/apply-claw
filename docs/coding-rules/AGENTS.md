# docs/coding-rules/CLAUDE.md

<commentOut>
<!-- 
[リバースナレッジ対象ファイル]
.claude/commands/update-claude-rules.md や Claude Code で 本ドキュメントを更新してください
-->
</commentOut>

## 文脈情報

このドキュメントは、コーディングルールをまとめた資料があるディレクトリです。
主に、tsc や Biome、Vitest などのツールではカバーしきれない、プログラムの書き方に関するルールを記載しています。

## ルール

- How (実装の詳細) をいちいち指示しなくても、「そのプロダクトにとって綺麗なコード」を出力してください

## 手順

1. コードを作成・変更する場合、[@docs/coding-rules/*.md](../coding-rules/*.md) を読み込んでください
2. 読み込んだ後、コーディングルールは、「（レイヤー） + （シーン別） + (実装 or テスト)」で記載されていることが多いので、指示を元に「（レイヤー） + （シーン別） + (実装 or テスト)」から一致するコーディングルールのみを読み込んでください
- 指示の具体例: サービス層(_.service.ts) の、CRUD 関数を実装してください
- コーディングルールの具体例: リポジトリ層(_.repository.ts) の CRUD関数の実装方法
3. 出力形式に合わせて、コードを作成・変更してください

## 出力形式

[@docs/coding-rules/*.md](../coding-rules/*.md) の例を参考に、コードを出力してください。

## 出典

<commentOut>
- [「規約、知識、オペレーション」から考える中規模以上の開発組織のCursorルールの 考え方・育て方 / Cursor Rules for Coding Styles, Domain Knowledges and Operations](https://speakerdeck.com/yuitosato/cursor-rules-for-coding-styles-domain-knowledges-and-operations?slide=41)
</commentOut>
