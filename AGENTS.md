# AGENTS.md

## 目的

このリポジトリでは、画面仕様書（`docs/screens/*.md`）と API 仕様書（`docs/api/*.md`）を実装と常に同期させる。

## 必須ルール

- 画面実装を変更した場合、同じコミット内で `docs/screens/*.md` を更新する。
- API 実装を変更した場合、同じコミット内で `docs/api/*.md` を更新する。
- `prisma/schema.prisma` または `prisma/seed.ts` を変更した場合、影響する画面/API仕様を更新する。
- 仕様書に「変更履歴」セクションは持たない（履歴は Git で管理）。
- 画面仕様書の「操作仕様」は、ユーザー目線のユースケース形式で記述する。
- 「操作仕様」は `#### <操作名>` の小見出しで分割し、各項目は「ユーザーは〜できる」「成功時〜」の文体で記述する。

## 対象範囲

- 画面実装: `src/app/**/page.tsx`, `src/components/**/*.tsx`, `src/lib/cdr/*`
- API 実装: `src/app/api/**/route.ts`, `src/lib/auth/*`

## 作業フロー（実装変更時）

1. 実装変更
2. 仕様書更新
- 画面: `docs/screens/*.md`
- API: `docs/api/*.md`
3. 整合確認
- `pnpm docs:check-sync`
4. PR 作成後
- GitHub Actions `Spec Sync Warning` で仕様同期を警告チェック（fail させない）

## 運用 Skill

- 仕様書更新時は `docs/skills/spec-sync/SKILL.md` の手順に従う。
- 新規画面は `docs/screens/_templates/screen-spec-template.md` から作成する。
- 新規 API は `docs/api/_templates/api-spec-template.md` から作成する。
