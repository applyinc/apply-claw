"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type React from "react";
import type { CronJob } from "@/app/types/cron";

import type { TasksSettings } from "./index";

type Props = React.ComponentProps<typeof TasksSettings>;

export function useTasksSettings(_props: Props) {
  const router = useRouter();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/jobs");
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  const onDelete = async (id: string) => {
    if (!window.confirm("Delete this job?")) {
      return;
    }

    await fetch("/api/cron/jobs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await fetchJobs();
  };

  const onToggleEnabled = async (job: CronJob) => {
    await fetch("/api/cron/jobs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, enabled: !job.enabled }),
    });
    await fetchJobs();
  };

  const onStartEdit = (id: string) => {
    router.push(`/tasks/${id}/edit`);
  };

  const enabledCount = jobs.filter((job) => job.enabled).length;
  const nextWakeAtMs = jobs
    .filter((job) => job.enabled && typeof job.state.nextRunAtMs === "number")
    .map((job) => job.state.nextRunAtMs as number)
    .sort((a, b) => a - b)[0] ?? null;
  const nextWakeLabel = nextWakeAtMs
    ? new Date(nextWakeAtMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "n/a";

  return {
    jobs,
    loading,
    enabledCount,
    nextWakeLabel,
    onDelete,
    onToggleEnabled,
    onStartEdit,
  };
}
