"use client";

import type React from "react";

import type { TaskListItem } from "./index";

type Props = React.ComponentProps<typeof TaskListItem>;

export function useTaskListItem(props: Props) {
  const { job, onToggleEnabled, onEdit, onDelete } = props;

  const onToggleEnabledButtonClick = (() => {
    onToggleEnabled(job);
  }) satisfies React.ComponentProps<"button">["onClick"];

  const onEditButtonClick = (() => {
    onEdit(job.id);
  }) satisfies React.ComponentProps<"button">["onClick"];

  const onDeleteButtonClick = (() => {
    onDelete(job.id);
  }) satisfies React.ComponentProps<"button">["onClick"];

  return {
    onToggleEnabledButtonClick,
    onEditButtonClick,
    onDeleteButtonClick,
  };
}
