---
description: ドキュメント「src/app 配下におけるコンポーネント構成ルール」
---

# docs/coding-rules/app-component-structure.md

## 指示

`src/app` 配下のコンポーネント構成ルールに従って、コンポーネントを実装してください

## 文脈情報

このドキュメントは、`src/app` 配下のすべてのコンポーネントにおける統一ルールを定義します。ロジックとビューを明確に分離し、保守性・可読性・テスタビリティの高いコードベースを維持することを目的としています。

## ルール

### 基本的なファイル構成

- コンポーネントは `[ComponentName]/index.tsx` と `[ComponentName]/hooks.ts` のペアで構成する
- **ロジックは `[ComponentName]/hooks.ts` に集約する**
- **`[ComponentName]/index.tsx` はシンプルに保ち、主にビュー(JSX)のみを記述する**
- コンポーネントの export は named export を使用する

### `[ComponentName]/hooks.ts` の責務

`[ComponentName]/hooks.ts` には以下のロジックを集約する:

- **Props 型定義**: `React.ComponentProps<typeof ComponentName>` でコンポーネントの Props 型を取得
- **状態管理**: `useState`, `useAtomValue`, `useSetAtom` などの状態フック
- **ref管理**: `useRef` による DOM 参照や可変値の管理
- **算出値**: derived values や条件付きフラグ
- **イベントハンドラ**: `onButtonClick`, `onInputChange`, `onFormSubmit` などのイベント処理ロジック
  - アロー関数の即時実行形式 `(() => {...})` で定義
  - `satisfies React.ComponentProps<"element">["eventName"]` で型を指定
- **副作用**: `useEffect`, データフェッチ, API呼び出し

**重要:** hook は Props を引数として受け取り、コンポーネントの Props とロジックを連携させる

### `[ComponentName]/index.tsx` の責務

`[ComponentName]/index.tsx` には以下のみを記述する:

- **Props 型定義**: コンポーネントの Props 型を定義
- **hook呼び出し**: `use[ComponentName](props)` で値・関数を取得
- **JSX構造**: コンポーネントのマークアップ
- **スタイル**: Tailwind CSS または shadcn/ui によるスタイル指定

**重要:** コンポーネントは Props を受け取り、それをそのまま hook に渡す

### 状態管理パターン

- **グローバル状態**: Jotai の atom を使用する（導入している場合）
- **ローカル状態**: `useState` を使用する
- **atom の配置**: 各機能ディレクトリの `shared/atom.ts` に集約
- **atom の操作**:
  - 読み取り専用: `useAtomValue` を使用
  - 書き込み専用: `useSetAtom` を使用

### イベントハンドラの命名規則

- イベントハンドラは `on*` プレフィックスを使用する
- 具体的な要素名を含める: `onButtonClick`, `onInputChange`, `onTextareaChange`
- イベントハンドラの型は `satisfies React.ComponentProps<"element">["eventName"]` で明示的に指定する
  - 例: `satisfies React.ComponentProps<"button">["onClick"]`
  - 例: `satisfies React.ComponentProps<"input">["onChange"]`
- 内部ヘルパー関数は `_` プレフィックスを使用する (例: `_resetLocalState`)

## 出力形式

### 基本的なコンポーネント構成例

#### `[ComponentName]/hooks.ts` の例

```ts
"use client";

import { useRef, useState, useEffect } from "react";
import type React from "react";

import type { ComponentName } from "./index";

type Props = React.ComponentProps<typeof ComponentName>;

export function useComponentName(props: Props) {
  const { defaultValue } = props;

  // 状態管理
  const [localState, setLocalState] = useState(defaultValue);
  const _resetLocalState = () => setLocalState(defaultValue);

  // ref管理
  const elementRef = useRef<HTMLDivElement>(null);

  // 算出値
  const isDisabled = localState.trim() === "";

  // イベントハンドラ
  const onInputChange = ((event) => {
    setLocalState(event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onButtonClick = (() => {
    if (isDisabled) {
      return;
    }
    // 処理
    _resetLocalState();
  }) satisfies React.ComponentProps<"button">["onClick"];

  // 副作用
  useEffect(() => {
    // 副作用処理
  }, [localState]);

  // 必要な値・関数を返す
  return {
    localState,
    isDisabled,
    elementRef,
    onButtonClick,
    onInputChange,
  };
}
```

#### `[ComponentName]/index.tsx` の例

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useComponentName } from "./hooks";

type Props = {
  defaultValue: string;
};

export function ComponentName(props: Props) {
  const { localState, isDisabled, elementRef, onButtonClick, onInputChange } =
    useComponentName(props);

  return (
    <div ref={elementRef} className="flex flex-col gap-4">
      <Input
        value={localState}
        onChange={onInputChange}
        placeholder="入力してください"
      />
      <Button onClick={onButtonClick} disabled={isDisabled}>
        送信
      </Button>
    </div>
  );
}
```

## 注意点

### 禁止事項

- `[ComponentName]/index.tsx` に複雑なロジックを書かない
  - 算出値、条件分岐、イベント処理ロジックなどは hook に移動する
  - JSX の構造とスタイルのみに集中する

### 必須事項

- すべてのロジックは `[ComponentName]/hooks.ts` に集約する
- hook から返す値は必要最小限にする（使用しない値は返さない）
- イベントハンドラは必ず hook 内で定義する
- イベントハンドラの型は `satisfies` で明示的に指定する

### 参考

- 分からない場合は、既存のコンポーネントを参考にする

### 適用範囲

- このルールは `src/app` 配下のすべてのコンポーネントに適用される
- `src/components/ui` 配下の shadcn/ui コンポーネントには適用されない

