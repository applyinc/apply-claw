"use client";

import { useEffect, useState } from "react";
import type React from "react";

import { INTERVAL_PRESETS, type JobFormData } from "../shared";
import type { TaskForm } from "./index";

type Props = React.ComponentProps<typeof TaskForm>;

export function useTaskForm(props: Props) {
  const { initial, onSave, onCancel, saving } = props;

  const [form, setForm] = useState<JobFormData>(initial);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const _setField = <K extends keyof JobFormData>(key: K, value: JobFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const canSave = form.name.trim().length > 0 && !saving;

  const onNameChange = ((event) => {
    _setField("name", event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onDescriptionChange = ((event) => {
    _setField("description", event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onMessageChange = ((event) => {
    _setField("message", event.target.value);
  }) satisfies React.ComponentProps<"textarea">["onChange"];

  const onCronExprChange = ((event) => {
    _setField("cronExpr", event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onCronTzChange = ((event) => {
    _setField("cronTz", event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onAtTimeChange = ((event) => {
    _setField("atTime", event.target.value);
  }) satisfies React.ComponentProps<"input">["onChange"];

  const onEnabledCheckedChange = (checked: boolean) => {
    _setField("enabled", checked);
  };

  const onSaveButtonClick = (() => {
    if (!canSave) {
      return;
    }
    onSave(form);
  }) satisfies React.ComponentProps<"button">["onClick"];

  const onCancelButtonClick = (() => {
    onCancel();
  }) satisfies React.ComponentProps<"button">["onClick"];

  return {
    form,
    canSave,
    intervalPresets: INTERVAL_PRESETS,
    setScheduleKind: (value: JobFormData["scheduleKind"]) => _setField("scheduleKind", value),
    setEveryMs: (value: number) => _setField("everyMs", value),
    setSessionTarget: (value: JobFormData["sessionTarget"]) => _setField("sessionTarget", value),
    onNameChange,
    onDescriptionChange,
    onMessageChange,
    onCronExprChange,
    onCronTzChange,
    onAtTimeChange,
    onEnabledCheckedChange,
    onSaveButtonClick,
    onCancelButtonClick,
  };
}
