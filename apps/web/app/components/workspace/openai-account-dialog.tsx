"use client";

import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type AuthProfileSummary = {
  id: string;
  provider: string;
  label: string;
  accountId: string | null;
  isCurrent: boolean;
};

type OpenAIAuthState = {
  provider: string;
  model: string;
  currentProfileId: string | null;
  profiles: AuthProfileSummary[];
};

type LoginSessionState = {
  id: string;
  status: "running" | "completed" | "failed";
  output: string;
  message: string | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onUpdated?: () => void;
};

const EMPTY_STATE: OpenAIAuthState = {
  provider: "openai-codex",
  model: "openai-codex/gpt-5.4",
  currentProfileId: null,
  profiles: [],
};

export function OpenAIAccountDialog(props: Props) {
  const { isOpen, onClose, onUpdated } = props;
  const [state, setState] = useState<OpenAIAuthState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loginSession, setLoginSession] = useState<LoginSessionState | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/model-auth/openai-codex", { cache: "no-store" });
      const data = (await res.json()) as OpenAIAuthState & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load OpenAI accounts.");
      }
      setState({
        provider: data.provider,
        model: data.model,
        currentProfileId: data.currentProfileId,
        profiles: data.profiles ?? [],
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load OpenAI accounts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void load();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!loginSession || loginSession.status !== "running") {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/model-auth/openai-codex/login?sessionId=${encodeURIComponent(loginSession.id)}`, {
          cache: "no-store",
        });
        const data = (await res.json()) as OpenAIAuthState & LoginSessionState & { error?: string; currentProfileId?: string | null };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to refresh login status.");
        }
        if (cancelled) {
          return;
        }
        setLoginSession({
          id: data.id,
          status: data.status,
          output: data.output,
          message: data.message,
        });

        if (data.status !== "running") {
          setState({
            provider: data.provider,
            model: data.model,
            currentProfileId: data.currentProfileId ?? null,
            profiles: data.profiles ?? [],
          });
          setBusyAction(null);
          setMessage(data.message ?? null);
          onUpdated?.();
          return;
        }
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setBusyAction(null);
        setLoginSession((current) => current ? { ...current, status: "failed" } : null);
        setError(nextError instanceof Error ? nextError.message : "Failed to refresh login status.");
        return;
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(() => {
          void poll();
        }, 1200);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [loginSession, onUpdated]);

  const runAction = async (action: string, endpoint: string, body?: Record<string, string>) => {
    setBusyAction(action);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as OpenAIAuthState & { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      setState({
        provider: data.provider,
        model: data.model,
        currentProfileId: data.currentProfileId,
        profiles: data.profiles ?? [],
      });
      setMessage(data.message ?? null);
      onUpdated?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Request failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const startLogin = async () => {
    setBusyAction("login");
    setError(null);
    setMessage(null);
    setLoginSession(null);
    try {
      const res = await fetch("/api/model-auth/openai-codex/login", { method: "POST" });
      const data = (await res.json()) as OpenAIAuthState & LoginSessionState & { error?: string; currentProfileId?: string | null };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start OpenAI login.");
      }
      setLoginSession({
        id: data.id,
        status: data.status,
        output: data.output,
        message: data.message,
      });

      if (data.status !== "running") {
        setState({
          provider: data.provider,
          model: data.model,
          currentProfileId: data.currentProfileId ?? null,
          profiles: data.profiles ?? [],
        });
        setBusyAction(null);
        setMessage(data.message ?? null);
        onUpdated?.();
      }
    } catch (nextError) {
      setBusyAction(null);
      setError(nextError instanceof Error ? nextError.message : "Failed to start OpenAI login.");
    }
  };

  const currentProfile = state.profiles.find((profile) => profile.isCurrent) ?? null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:w-[calc(100vw-4rem)] md:w-[720px] lg:w-[840px] max-w-none sm:max-w-none max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>OpenAI Account</DialogTitle>
          <DialogDescription>
            OpenClaw uses the existing Codex OAuth flow. The model stays fixed to {state.model}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-500">Current model</div>
            <div className="mt-2 text-sm font-medium text-neutral-900">{state.model}</div>
            <div className="mt-1 text-xs text-neutral-500">
              Provider: {state.provider}
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-neutral-900">Connected accounts</div>
                <div className="mt-1 text-xs text-neutral-500">
                  {currentProfile ? `Current: ${currentProfile.label}` : "No OpenAI account connected yet."}
                </div>
              </div>
              <Button
                type="button"
                className="rounded-[14px] bg-neutral-900 text-white hover:bg-neutral-800"
                disabled={busyAction !== null}
                onClick={() => void startLogin()}
              >
                {busyAction === "login" ? "Starting login..." : "Sign in with OpenAI"}
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {loading ? (
                <div className="rounded-2xl border border-dashed border-neutral-200 px-4 py-6 text-sm text-neutral-500">
                  Loading accounts...
                </div>
              ) : state.profiles.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-neutral-200 px-4 py-6 text-sm text-neutral-500">
                  No OpenAI Codex accounts are connected.
                </div>
              ) : (
                state.profiles.map((profile) => (
                  <div key={profile.id} className="flex flex-col gap-3 rounded-2xl border border-neutral-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-neutral-900">{profile.label}</div>
                      <div className="mt-1 truncate text-xs text-neutral-500">
                        {profile.accountId ?? profile.id}
                      </div>
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
                      {profile.isCurrent ? (
                        <span className="rounded-full border border-neutral-300 bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-700">
                          Current
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-[12px] border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
                          disabled={busyAction !== null}
                          onClick={() => void runAction(`select:${profile.id}`, "/api/model-auth/openai-codex/select", { profileId: profile.id })}
                        >
                          {busyAction === `select:${profile.id}` ? "Switching..." : "Use this account"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        className="rounded-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                        disabled={busyAction !== null}
                        onClick={() => void runAction(`disconnect:${profile.id}`, "/api/model-auth/openai-codex/disconnect", { profileId: profile.id })}
                      >
                        {busyAction === `disconnect:${profile.id}` ? "Removing..." : "Disconnect"}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {loginSession ? (
            <div className="rounded-2xl border border-neutral-200 bg-neutral-950 px-4 py-3 text-xs text-neutral-100">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="font-medium">
                  {loginSession.status === "running" ? "Login in progress" : loginSession.status === "completed" ? "Login completed" : "Login failed"}
                </span>
                <span className="text-neutral-400">{loginSession.id.slice(0, 8)}</span>
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-neutral-200">
                {loginSession.output || "Waiting for OpenClaw to print login instructions..."}
              </pre>
            </div>
          ) : null}

          {message ? (
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="pt-1">
          <Button
            type="button"
            variant="outline"
            className="rounded-[14px] border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100"
            onClick={onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
