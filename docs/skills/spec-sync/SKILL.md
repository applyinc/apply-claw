---
name: spec-sync
description: 画面/API実装の変更時に docs/screens と docs/api を実装準拠で更新し、仕様とのズレを防ぐための運用手順。
---

# Spec Sync

## 使うタイミング

- `src/app/**/page.tsx` や `src/components/**` を変更したとき
- `src/app/api/**/route.ts` や `src/lib/auth/**` を変更したとき
- `prisma/schema.prisma` を変更したとき

## 手順

1. 差分確認
- 変更ファイルを確認し、影響する画面/APIを列挙する。

2. 仕様書更新
- 画面仕様: `docs/screens/*.md`
- API仕様: `docs/api/*.md`
- 既存記述は実装値に合わせる（必須/任意、HTTP ステータス、エラー文言、更新対象項目）。
- 画面仕様の「操作仕様」は、ユーザー目線のシナリオ形式に統一する。
- 操作仕様は `#### <操作名>` のサブセクションに分割する。
- 各 bullet は「ユーザーは〜できる」「〜に成功すると…」で記述する。

3. テンプレート運用
- 新規画面: `docs/screens/_templates/screen-spec-template.md`
- 新規API: `docs/api/_templates/api-spec-template.md`

4. 同期チェック
- `pnpm docs:check-sync` を実行する。

## 記述ルール

- 「変更履歴」セクションは追加しない。
- 実装にない挙動を書かない。
- 未確定項目は「未決事項」に明記する。
- 「操作仕様」に実装イベント名だけを列挙しない（例: `POST /...` だけの記述は禁止）。
- API パスや技術詳細は必要最小限にし、まずユーザーの行動と結果を先に書く。
