"use client";

import { useRouter } from "next/navigation";
import type React from "react";
import { useState } from "react";

import { defaultForm, formToBody, type JobFormData } from "../shared";
import type { NewJobScreen } from "./index";

type Props = React.ComponentProps<typeof NewJobScreen>;

export function useNewJobScreen(_props: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const onSave = async (form: JobFormData) => {
    setSaving(true);
    try {
      await fetch("/api/cron/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToBody(form)),
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
    initialForm: defaultForm(),
    saving,
    onSave,
    onCancel,
  };
}
