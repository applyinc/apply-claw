"use client";

import { useRouter } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import type { CronJob } from "@/app/types/cron";
import { formToBody, jobToForm, type JobFormData } from "../shared";
import type { EditJobScreen } from "./index";

type Props = React.ComponentProps<typeof EditJobScreen>;

export function useEditJobScreen(props: Props) {
  const { jobId } = props;
  const router = useRouter();
  const [job, setJob] = useState<CronJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchJob = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cron/jobs");
      const data = await res.json();
      const jobs = (data.jobs ?? []) as CronJob[];
      setJob(jobs.find((item) => item.id === jobId) ?? null);
    } catch {
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void fetchJob();
  }, [fetchJob]);

  const onSave = async (form: JobFormData) => {
    setSaving(true);
    try {
      await fetch("/api/cron/jobs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId, ...formToBody(form) }),
      });
      router.push("/tasks");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => {
    router.push("/tasks");
  };

  return {
    job,
    loading,
    saving,
    initialForm: job ? jobToForm(job) : null,
    onSave,
    onCancel,
  };
}
