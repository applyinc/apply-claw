"use client";

import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import type { CronJob } from "@/app/types/cron";

import { formatSchedule, formatStatus, relativeTime } from "../shared";
import { useTaskListItem } from "./hooks";

type Props = {
  job: CronJob;
  onToggleEnabled: (job: CronJob) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

export function TaskListItem(props: Props) {
  const { job } = props;
  const { onToggleEnabledButtonClick, onEditButtonClick, onDeleteButtonClick } = useTaskListItem(props);
  const status = formatStatus(job);

  return (
    <Card className="rounded-[18px] border-neutral-200 bg-neutral-50 shadow-none transition-colors hover:bg-white">
      <CardContent className="flex items-start gap-4 p-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mt-0.5 h-10 w-10 shrink-0 rounded-[12px] border border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-100"
          title={job.enabled ? "Disable" : "Enable"}
          onClick={onToggleEnabledButtonClick}
        >
          {job.enabled ? <Play size={18} /> : <Pause size={18} />}
        </Button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-neutral-900">{job.name}</span>
            <span
              className="rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{ color: status.color, background: `color-mix(in srgb, ${status.color} 10%, white)` }}
            >
              {status.label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span>{formatSchedule(job.schedule)}</span>
            <span>Last: {relativeTime(job.state.lastRunAtMs)}</span>
            {job.description ? <span className="truncate">{job.description}</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-[12px] text-neutral-500 hover:bg-white hover:text-neutral-800"
            title="Edit"
            onClick={onEditButtonClick}
          >
            <Pencil size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-[12px] text-neutral-500 hover:bg-white hover:text-neutral-900"
            title="Delete"
            onClick={onDeleteButtonClick}
          >
            <Trash2 size={16} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
