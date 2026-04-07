"use client";

import { Check, X } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { CardContent } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import type { JobFormData } from "../shared";
import { useTaskForm } from "./hooks";

type Props = {
  initial: JobFormData;
  onSave: (data: JobFormData) => void;
  onCancel: () => void;
  saving: boolean;
};

export function TaskForm(props: Props) {
  const {
    form,
    canSave,
    intervalPresets,
    setScheduleKind,
    setEveryMs,
    setSessionTarget,
    onNameChange,
    onDescriptionChange,
    onMessageChange,
    onCronExprChange,
    onCronTzChange,
    onAtTimeChange,
    onEnabledCheckedChange,
    onSaveButtonClick,
    onCancelButtonClick,
  } = useTaskForm(props);

  return (
    <CardContent className="space-y-5 p-0">
      <div className="rounded-[18px] border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-lg font-semibold tracking-tight text-neutral-800">Basics</p>
        <p className="mt-1 text-sm text-neutral-500">Name it, choose the assistant, and set enabled state.</p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div>
        <Label className="mb-2 block text-sm font-medium text-neutral-500">Name</Label>
        <Input
          className="h-11 rounded-[14px] border-neutral-200 bg-white shadow-none placeholder:text-neutral-400"
          value={form.name}
          onChange={onNameChange}
          placeholder="Job name"
        />
      </div>

      <div>
        <Label className="mb-2 block text-sm font-medium text-neutral-500">Description</Label>
        <Input
          className="h-11 rounded-[14px] border-neutral-200 bg-white shadow-none placeholder:text-neutral-400"
          value={form.description}
          onChange={onDescriptionChange}
          placeholder="Optional description"
        />
      </div>
        </div>

        <div className="mt-4">
        <Label className="mb-2 block text-sm font-medium text-neutral-500">Agent prompt</Label>
        <Textarea
          className="min-h-[120px] resize-y rounded-[14px] border-neutral-200 bg-white shadow-none placeholder:text-neutral-400"
          value={form.message}
          onChange={onMessageChange}
          placeholder="Message to send to the agent on each run"
        />
      </div>
      </div>

      <div className="rounded-[18px] border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-lg font-semibold tracking-tight text-neutral-800">Schedule</p>
        <p className="mt-1 text-sm text-neutral-500">Control when this job runs.</p>

        <div className="mt-5">
        <Label className="mb-2 block text-sm font-medium text-neutral-500">Schedule</Label>
        <div className="flex gap-2 mb-2">
          {(["every", "cron", "at"] as const).map((kind) => (
            <Button
              key={kind}
              type="button"
              variant={form.scheduleKind === kind ? "default" : "outline"}
              size="sm"
              className={form.scheduleKind === kind ? "rounded-[12px] bg-neutral-900 text-white hover:bg-neutral-800" : "rounded-[12px] border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100"}
              onClick={() => setScheduleKind(kind)}
            >
              {kind === "every" ? "Interval" : kind === "cron" ? "Cron" : "One-time"}
            </Button>
          ))}
        </div>

        {form.scheduleKind === "every" ? (
          <div className="flex flex-wrap gap-2">
            {intervalPresets.map((preset) => (
              <Button
                key={preset.value}
                type="button"
                variant={form.everyMs === preset.value ? "default" : "outline"}
                size="sm"
                className={form.everyMs === preset.value ? "rounded-[12px] bg-neutral-900 text-white hover:bg-neutral-800" : "rounded-[12px] border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100"}
                onClick={() => setEveryMs(preset.value)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        ) : null}

        {form.scheduleKind === "cron" ? (
          <div className="flex gap-2">
            <Input
              className="h-11 flex-1 rounded-[14px] border-neutral-200 bg-white font-mono shadow-none placeholder:text-neutral-400"
              value={form.cronExpr}
              onChange={onCronExprChange}
              placeholder="0 * * * *"
            />
            <Input
              className="h-11 w-40 rounded-[14px] border-neutral-200 bg-white shadow-none placeholder:text-neutral-400"
              value={form.cronTz}
              onChange={onCronTzChange}
              placeholder="Timezone (optional)"
            />
          </div>
        ) : null}

        {form.scheduleKind === "at" ? (
          <Input
            className="h-11 rounded-[14px] border-neutral-200 bg-white shadow-none"
            type="datetime-local"
            value={form.atTime}
            onChange={onAtTimeChange}
          />
        ) : null}
      </div>
      </div>

      <div className="rounded-[18px] border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-lg font-semibold tracking-tight text-neutral-800">Execution</p>
        <p className="mt-1 text-sm text-neutral-500">Choose how the agent session is created and delivered.</p>

        <div className="mt-5">
        <Label className="mb-2 block text-sm font-medium text-neutral-500">Session</Label>
        <div className="flex gap-2">
          {(["isolated", "main"] as const).map((target) => (
            <Button
              key={target}
              type="button"
              variant={form.sessionTarget === target ? "default" : "outline"}
              size="sm"
              className={form.sessionTarget === target ? "rounded-[12px] bg-neutral-900 text-white hover:bg-neutral-800" : "rounded-[12px] border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100"}
              onClick={() => setSessionTarget(target)}
            >
              {target === "isolated" ? "Isolated" : "Main agent"}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-[14px] border border-neutral-200 bg-white px-4 py-3">
        <Label htmlFor="task-enabled" className="text-sm font-medium text-neutral-600">Enabled</Label>
        <Switch
          id="task-enabled"
          className="data-[state=checked]:bg-neutral-900 data-[state=unchecked]:bg-neutral-300"
          checked={form.enabled}
          onCheckedChange={onEnabledCheckedChange}
        />
      </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button
          type="button"
          onClick={onSaveButtonClick}
          className="rounded-[14px] bg-neutral-900 px-5 text-white hover:bg-neutral-800"
          disabled={!canSave}
        >
          <Check size={16} />
          {props.saving ? "Saving..." : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-[14px] border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
          onClick={onCancelButtonClick}
        >
          <X size={16} />
          Cancel
        </Button>
      </div>
    </CardContent>
  );
}
