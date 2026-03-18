"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";
const DENCHCLAW_VERSION = process.env.NEXT_PUBLIC_DENCHCLAW_VERSION || "";
const OPENCLAW_VERSION = process.env.NEXT_PUBLIC_OPENCLAW_VERSION || "";

type PersonInfo = {
  name?: string;
  email?: string;
  avatar?: string;
  denchOrgId?: string;
};

let initialized = false;

function initPostHog(anonymousId?: string, personInfo?: PersonInfo, privacyMode?: boolean) {
  if (initialized || !POSTHOG_KEY || typeof window === "undefined") return;

  const privacy = privacyMode !== false;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "memory",
    autocapture: false,
    disable_session_recording: false,
    person_profiles: "always",
    session_recording: {
      maskAllInputs: privacy,
      maskTextSelector: privacy ? "*" : undefined,
    },
    bootstrap: anonymousId
      ? { distinctID: anonymousId, isIdentifiedID: false }
      : undefined,
  });

  const superProps: Record<string, string> = {};
  if (DENCHCLAW_VERSION) superProps.denchclaw_version = DENCHCLAW_VERSION;
  if (OPENCLAW_VERSION) superProps.openclaw_version = OPENCLAW_VERSION;
  if (Object.keys(superProps).length > 0) posthog.register(superProps);

  if (personInfo && anonymousId) {
    const props: Record<string, string> = {};
    if (personInfo.name) props.$name = personInfo.name;
    if (personInfo.email) props.$email = personInfo.email;
    if (personInfo.avatar) props.$avatar = personInfo.avatar;
    if (personInfo.denchOrgId) props.dench_org_id = personInfo.denchOrgId;
    posthog.identify(anonymousId, props);
  }

  initialized = true;
}

function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!initialized) return;
    const wsPath = searchParams?.get("path") ?? "";
    if (wsPath.startsWith("~cron")) return;
    const url = pathname + (searchParams?.toString() ? `?${searchParams.toString()}` : "");
    posthog.capture("$pageview", { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}

export function PostHogProvider({
  children,
  anonymousId,
  personInfo,
  privacyMode,
}: {
  children: React.ReactNode;
  anonymousId?: string;
  personInfo?: PersonInfo;
  privacyMode?: boolean;
}) {
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    initPostHog(anonymousId, personInfo, privacyMode);
  }, [anonymousId, personInfo, privacyMode]);

  if (!POSTHOG_KEY) return <>{children}</>;

  return (
    <PHProvider client={posthog}>
      <PageviewTracker />
      {children}
    </PHProvider>
  );
}
