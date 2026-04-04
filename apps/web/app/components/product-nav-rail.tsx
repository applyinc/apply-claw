"use client";

import Link from "next/link";
import { House, Clock } from "lucide-react";

export type ProductRoute = "home" | "tasks";

export function ProductNavRail({ activeProduct }: { activeProduct: ProductRoute }) {
  return (
    <nav
      className="flex flex-col items-center shrink-0 border-r"
      style={{
        width: 48,
        minWidth: 48,
        background: "var(--color-sidebar-bg)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="flex items-center justify-center w-full h-12 shrink-0" />

      <div className="flex flex-col items-center gap-1 py-1">
        <Link
          href="/"
          className="flex flex-col items-center justify-center gap-0.5 w-10 h-12 rounded-lg transition-colors"
          style={{
            color: activeProduct === "home" ? "var(--color-text)" : "var(--color-text-muted)",
            background: activeProduct === "home" ? "var(--color-surface-hover)" : "transparent",
          }}
          title="Home"
        >
          <House size={22} />
          <span className="text-[9px] leading-none font-medium">Home</span>
        </Link>
        <Link
          href="/tasks"
          className="flex flex-col items-center justify-center gap-0.5 w-10 h-12 rounded-lg transition-colors"
          style={{
            color: activeProduct === "tasks" ? "var(--color-text)" : "var(--color-text-muted)",
            background: activeProduct === "tasks" ? "var(--color-surface-hover)" : "transparent",
          }}
          title="Tasks"
        >
          <Clock size={22} />
          <span className="text-[9px] leading-none font-medium">Tasks</span>
        </Link>
      </div>
    </nav>
  );
}
