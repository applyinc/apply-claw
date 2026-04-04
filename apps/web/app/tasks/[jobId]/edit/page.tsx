"use client";

import { useParams } from "next/navigation";
import { EditJobScreen } from "../../../components/tasks/edit-job-screen";
import { ProductNavRail } from "../../../components/product-nav-rail";
import { useIsMobile } from "../../../hooks/use-mobile";

export default function EditTaskPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = typeof params.jobId === "string" ? params.jobId : "";
  const isMobile = useIsMobile();

  return (
    <div className="flex h-screen" style={{ background: "var(--color-main-bg)" }}>
      {!isMobile ? <ProductNavRail activeProduct="tasks" /> : null}
      <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "var(--color-surface)" }}>
        <EditJobScreen jobId={jobId} />
      </div>
    </div>
  );
}
