import { TRPCError, initTRPC } from "@trpc/server";

import {
  capabilitiesResponseSchema,
  type CapabilitiesResponse,
  activeModelResponseSchema,
  type ActiveModelResponse,
  healthResponseSchema,
  type HealthResponse,
  versionResponseSchema,
  type VersionResponse,
  workspaceListResponseSchema,
  type WorkspaceListResponse,
  workspaceSwitchInputSchema,
  type WorkspaceSwitchResponse,
  workspaceSwitchResponseSchema,
} from "@applyclaw/api-schema";

import type { ControlApiContext } from "./context.js";
import { resolveBundledOpenClawVersion, resolveControlApiVersion } from "./version.js";
import { getActiveModel, listWorkspaces, switchWorkspace } from "./workspace-service.js";

const t = initTRPC.context<ControlApiContext>().create();

function buildHealthResponse(): HealthResponse {
  return {
    status: "ok",
    service: "control-api",
    now: new Date().toISOString(),
  };
}

function buildVersionResponse(): VersionResponse {
  return {
    service: "control-api",
    version: resolveControlApiVersion(),
    openclawVersion: resolveBundledOpenClawVersion(),
  };
}

function buildCapabilitiesResponse(ctx: ControlApiContext): CapabilitiesResponse {
  return {
    service: "control-api",
    auth: {
      enabled: ctx.authTokenConfigured,
      scheme: "bearer",
    },
    transport: {
      trpcPath: "/trpc",
      healthPath: "/health",
      versionPath: "/version",
      capabilitiesPath: "/capabilities",
    },
    features: {
      gateway: true,
      workspace: true,
      modelAuth: true,
      tasks: true,
    },
  };
}

function buildWorkspaceListResponse(): WorkspaceListResponse {
  return listWorkspaces();
}

function buildActiveModelResponse(): ActiveModelResponse {
  return {
    model: getActiveModel(),
  };
}

function buildWorkspaceSwitchResponse(workspace: string): WorkspaceSwitchResponse {
  try {
    return switchWorkspace(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to switch workspace.";
    if (message.startsWith("Invalid workspace name")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message,
      });
    }
    if (message.includes("was not found")) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message,
      });
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message,
    });
  }
}

export const appRouter = t.router({
  capabilities: t.procedure
    .output(capabilitiesResponseSchema)
    .query(({ ctx }) => buildCapabilitiesResponse(ctx)),
  health: t.procedure.output(healthResponseSchema).query(() => buildHealthResponse()),
  version: t.procedure.output(versionResponseSchema).query(() => buildVersionResponse()),
  workspace: t.router({
    activeModel: t.procedure
      .output(activeModelResponseSchema)
      .query(() => buildActiveModelResponse()),
    list: t.procedure
      .output(workspaceListResponseSchema)
      .query(() => buildWorkspaceListResponse()),
    switch: t.procedure
      .input(workspaceSwitchInputSchema)
      .output(workspaceSwitchResponseSchema)
      .mutation(({ input }) => buildWorkspaceSwitchResponse(input.workspace)),
  }),
});

export type AppRouter = typeof appRouter;

export function getHealthResponse(): HealthResponse {
  return buildHealthResponse();
}

export function getVersionResponse(): VersionResponse {
  return buildVersionResponse();
}

export function getCapabilitiesResponse(ctx: ControlApiContext): CapabilitiesResponse {
  return buildCapabilitiesResponse(ctx);
}
