import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("control-api"),
  now: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const versionResponseSchema = z.object({
  service: z.literal("control-api"),
  version: z.string().min(1),
  openclawVersion: z.string().min(1).nullable(),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;

export const capabilitiesResponseSchema = z.object({
  service: z.literal("control-api"),
  auth: z.object({
    enabled: z.boolean(),
    scheme: z.literal("bearer"),
  }),
  transport: z.object({
    trpcPath: z.literal("/trpc"),
    healthPath: z.literal("/health"),
    versionPath: z.literal("/version"),
    capabilitiesPath: z.literal("/capabilities"),
  }),
  features: z.object({
    gateway: z.boolean(),
    workspace: z.boolean(),
    modelAuth: z.boolean(),
    tasks: z.boolean(),
  }),
});

export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

export const workspaceGatewayMetaSchema = z.object({
  mode: z.string().optional(),
  port: z.number().int().positive().optional(),
  url: z.string().optional(),
}).nullable();

export const workspaceSummarySchema = z.object({
  name: z.string().min(1),
  stateDir: z.string().min(1),
  workspaceDir: z.string().nullable(),
  isActive: z.boolean(),
  hasConfig: z.boolean(),
  gateway: workspaceGatewayMetaSchema,
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceListResponseSchema = z.object({
  activeWorkspace: z.string().nullable(),
  workspaces: z.array(workspaceSummarySchema),
});

export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const activeModelResponseSchema = z.object({
  model: z.string().nullable(),
});

export type ActiveModelResponse = z.infer<typeof activeModelResponseSchema>;

export const workspaceSwitchInputSchema = z.object({
  workspace: z.string().min(1),
});

export const workspaceSwitchResponseSchema = z.object({
  activeWorkspace: z.string().nullable(),
  stateDir: z.string().min(1),
  workspaceRoot: z.string().nullable(),
  workspace: workspaceSummarySchema.nullable(),
});

export type WorkspaceSwitchInput = z.infer<typeof workspaceSwitchInputSchema>;
export type WorkspaceSwitchResponse = z.infer<typeof workspaceSwitchResponseSchema>;
