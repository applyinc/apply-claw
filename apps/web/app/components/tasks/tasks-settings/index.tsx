"use client";

import Link from "next/link";
import { Clock, Plus } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { TaskListItem } from "../task-list-item";
import { useTasksSettings } from "./hooks";

type Props = Record<string, never>;

export function TasksSettings(_props: Props) {
  const {
    jobs,
    loading,
    enabledCount,
    nextWakeLabel,
    onDelete,
    onToggleEnabled,
    onStartEdit,
  } = useTasksSettings(_props);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--color-text-muted)" }}>
        Loading tasks...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-5 py-7 md:px-7">
        <div className="mb-6">
          <div>
            <h1 className="text-[2rem] font-semibold tracking-tight text-[#d33b2f]">Cron Jobs</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Manage scheduled cron jobs for your agents
            </p>
          </div>
        </div>

        <div className="mb-5 flex flex-col gap-3 rounded-[24px] border border-neutral-200 bg-neutral-50 p-4 md:flex-row">
          <div className="grid flex-1 gap-3 md:grid-cols-3">
            <div className="rounded-[16px] border border-neutral-200 bg-white px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Enabled</p>
              <div className="mt-3">
                <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                  {enabledCount > 0 ? "Yes" : "No"}
                </span>
              </div>
            </div>
            <div className="rounded-[16px] border border-neutral-200 bg-white px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Jobs</p>
              <p className="mt-3 text-[1.75rem] font-semibold tracking-tight text-neutral-800">{jobs.length}</p>
            </div>
            <div className="rounded-[16px] border border-neutral-200 bg-white px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Next Wake</p>
              <p className="mt-3 text-lg font-semibold tracking-tight text-neutral-800">{nextWakeLabel}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <Card className="rounded-[24px] border-neutral-200 bg-white shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-[1.65rem] tracking-tight text-neutral-900">Jobs</CardTitle>
                  <p className="mt-2 text-sm text-neutral-500">All scheduled jobs stored in the gateway.</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="pt-1 text-sm text-neutral-400">{jobs.length} shown</span>
                  <Button asChild variant="outline" className="h-11 rounded-[14px] border-neutral-200 bg-white px-4 text-neutral-700 shadow-none hover:bg-neutral-100">
                    <Link href="/tasks/new">
                      <Plus size={16} />
                      + New Job
                    </Link>
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {jobs.length === 0 ? (
                <div className="rounded-[18px] border border-dashed border-neutral-200 bg-neutral-50 py-16 text-center">
                  <Clock size={40} className="mx-auto mb-3 text-neutral-300" />
                  <p className="text-sm text-neutral-500">No matching jobs.</p>
                </div>
              ) : (
                jobs.map((job) => (
                  <TaskListItem
                    key={job.id}
                    job={job}
                    onToggleEnabled={onToggleEnabled}
                    onEdit={onStartEdit}
                    onDelete={onDelete}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
