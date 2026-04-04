"use client";

import { NewJobScreen } from "../../components/tasks/new-job-screen";
import { ProductNavRail } from "../../components/product-nav-rail";
import { useIsMobile } from "../../hooks/use-mobile";

export default function NewTaskPage() {
  const isMobile = useIsMobile();

  return (
    <div className="flex h-screen" style={{ background: "var(--color-main-bg)" }}>
      {!isMobile ? <ProductNavRail activeProduct="tasks" /> : null}
      <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "var(--color-surface)" }}>
        <NewJobScreen />
      </div>
    </div>
  );
}
