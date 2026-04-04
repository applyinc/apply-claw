"use client";

import { TasksSettings } from "../components/tasks/tasks-settings";
import { ProductNavRail } from "../components/product-nav-rail";
import { useIsMobile } from "../hooks/use-mobile";

export default function TasksPage() {
  const isMobile = useIsMobile();

  return (
    <div className="flex h-screen" style={{ background: "var(--color-main-bg)" }}>
      {!isMobile ? <ProductNavRail activeProduct="tasks" /> : null}
      <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "var(--color-surface)" }}>
        <TasksSettings />
      </div>
    </div>
  );
}
