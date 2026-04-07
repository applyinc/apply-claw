"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { TaskForm } from "../task-form";
import { useNewJobScreen } from "./hooks";

type Props = Record<string, never>;

export function NewJobScreen(_props: Props) {
  const { initialForm, saving, onSave, onCancel } = useNewJobScreen(_props);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-7 md:px-7">
        <div className="mb-6 flex items-center gap-3">
          <Button asChild variant="outline" className="rounded-[14px] border-neutral-200 bg-white text-neutral-700 shadow-none hover:bg-neutral-100">
            <Link href="/tasks">
              <ChevronLeft size={16} />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-[2rem] font-semibold tracking-tight text-neutral-900">New Job</h1>
            <p className="mt-1 text-sm text-neutral-500">Create a scheduled wakeup or agent run.</p>
          </div>
        </div>

        <Card className="rounded-[24px] border-neutral-200 bg-white shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-[1.65rem] tracking-tight text-neutral-900">Job Setup</CardTitle>
            <p className="text-sm text-neutral-500">Configure the basics, schedule, and execution settings.</p>
            <p className="text-sm font-medium text-neutral-500">* Required</p>
          </CardHeader>
          <CardContent>
            <TaskForm initial={initialForm} onSave={onSave} onCancel={onCancel} saving={saving} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
