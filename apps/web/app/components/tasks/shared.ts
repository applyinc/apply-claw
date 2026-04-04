"use client";

import type { CronJob, CronPayload, CronSchedule } from "@/app/types/cron";

export type JobFormData = {
  name: string;
  description: string;
  enabled: boolean;
  scheduleKind: "every" | "cron" | "at";
  everyMs: number;
  cronExpr: string;
  cronTz: string;
  atTime: string;
  message: string;
  sessionTarget: "main" | "isolated";
};

export const INTERVAL_PRESETS = [
  { label: "5 min", value: 300000 },
  { label: "15 min", value: 900000 },
  { label: "30 min", value: 1800000 },
  { label: "1 hour", value: 3600000 },
  { label: "6 hours", value: 21600000 },
  { label: "12 hours", value: 43200000 },
  { label: "24 hours", value: 86400000 },
] as const;

export function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "cron") {
    return schedule.expr + (schedule.tz ? ` (${schedule.tz})` : "");
  }
  if (schedule.kind === "every") {
    const mins = Math.round(schedule.everyMs / 60000);
    if (mins < 60) return `Every ${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `Every ${hrs}h`;
    return `Every ${Math.round(hrs / 24)}d`;
  }
  if (schedule.kind === "at") return `Once at ${schedule.at}`;
  return "Unknown";
}

export function formatStatus(job: CronJob): { label: string; color: string } {
  if (!job.enabled) return { label: "Disabled", color: "var(--color-text-muted)" };
  if (job.state.runningAtMs) return { label: "Running", color: "var(--color-info)" };
  if (job.state.lastStatus === "error") return { label: "Error", color: "var(--color-error)" };
  if (job.state.lastStatus === "ok") return { label: "OK", color: "var(--color-success)" };
  return { label: "Idle", color: "var(--color-text-muted)" };
}

export function relativeTime(ms: number | undefined): string {
  if (!ms) return "Never";
  const diff = Date.now() - ms;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

export function defaultForm(): JobFormData {
  return {
    name: "",
    description: "",
    enabled: true,
    scheduleKind: "every",
    everyMs: 3600000,
    cronExpr: "0 * * * *",
    cronTz: "",
    atTime: "",
    message: "",
    sessionTarget: "isolated",
  };
}

export function jobToForm(job: CronJob): JobFormData {
  const schedule = job.schedule;
  return {
    name: job.name,
    description: job.description ?? "",
    enabled: job.enabled,
    scheduleKind: schedule.kind,
    everyMs: schedule.kind === "every" ? schedule.everyMs : 3600000,
    cronExpr: schedule.kind === "cron" ? schedule.expr : "0 * * * *",
    cronTz: schedule.kind === "cron" ? (schedule.tz ?? "") : "",
    atTime: schedule.kind === "at" ? schedule.at : "",
    message: job.payload.kind === "agentTurn" ? job.payload.message : (job.payload as { text?: string }).text ?? "",
    sessionTarget: job.sessionTarget,
  };
}

export function formToBody(form: JobFormData): Record<string, unknown> {
  let schedule: CronSchedule;
  if (form.scheduleKind === "every") {
    schedule = { kind: "every", everyMs: form.everyMs };
  } else if (form.scheduleKind === "cron") {
    schedule = { kind: "cron", expr: form.cronExpr, ...(form.cronTz ? { tz: form.cronTz } : {}) };
  } else {
    schedule = { kind: "at", at: form.atTime };
  }

  const payload: CronPayload = { kind: "agentTurn", message: form.message };

  return {
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    schedule,
    payload,
    sessionTarget: form.sessionTarget,
    wakeMode: "next-heartbeat" as const,
  };
}
