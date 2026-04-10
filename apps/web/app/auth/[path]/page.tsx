"use client";

import { AuthView } from "@neondatabase/auth/react/ui";
import { NeonAuthUIProvider } from "@neondatabase/auth/react/ui";
import { authClient } from "@/lib/auth/client";
import { useParams } from "next/navigation";

export default function AuthPage() {
  const params = useParams<{ path: string }>();

  return (
    <NeonAuthUIProvider authClient={authClient}>
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]">
        <div className="w-full max-w-md p-6">
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-bold text-[var(--color-text)]">
              AppLy Claw
            </h1>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              AI Workspace with an agent that connects to your apps
            </p>
          </div>
          <AuthView
            pathname={`/auth/${params.path}`}
            redirectTo="/"
          />
        </div>
      </div>
    </NeonAuthUIProvider>
  );
}
