import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { buildControlApiContext } from "./context.js";
import {
  authMiddleware,
  createCorsMiddleware,
  requestIdMiddleware,
  requestLoggerMiddleware,
} from "./middleware.js";
import {
  appRouter,
  getCapabilitiesResponse,
  getHealthResponse,
  getVersionResponse,
} from "./router.js";
import {
  copyPath,
  createDirectory,
  deleteWorkspaceFile,
  getBrowseEntries,
  getBrowseFile,
  getAssetFile,
  getRawFile,
  getWorkspaceFile,
  uploadWorkspaceFile,
  movePath,
  renamePath,
  writeRawFile,
  writeWorkspaceFile,
} from "./filesystem-service.js";
import {
  disconnectProfile,
  ensurePrimaryModel,
  getLoginSession,
  getModelAuthSummary,
  listProfilesSummary,
  OPENAI_CODEX_MODEL,
  OPENAI_CODEX_PROVIDER,
  setSelectedProfile,
  startOpenAiCodexLoginSession,
  switchProfileSummary,
} from "./model-auth-service.js";
import { getGatewayChannels, getGatewaySessionMessages, getGatewaySessions } from "./gateway-service.js";
import { corsProxy, deleteAppStoreValue, getAppStoreValue, getWebhookEvents, handleWebhookIncoming, serveAppFile, setAppStoreValue } from "./app-hosting-service.js";
import { callGatewayRpc } from "./gateway-rpc-client.js";
import { createCronJob, deleteCronJob, getCronJobRuns, getCronRunTranscript, listCronJobs, searchCronTranscript, updateCronJob } from "./cron-service.js";
import { generateThumbnail, openFile } from "./desktop-service.js";
import { getMemories } from "./memory-service.js";
import { submitFeedback } from "./feedback-service.js";
import { TERMINAL_WS_PATH } from "./terminal-service.js";
import { getSessionTranscript, listAllSessions } from "./session-service.js";
import { listSkills } from "./skills-service.js";
import { createWebSession, deleteWebSession, getWebSession, listWebSessions, updateWebSession, upsertWebSessionMessages, getSessionMeta, readIndex, resolveSessionKey } from "./web-session-service.js";
import {
  startRun, startSubscribeRun, hasActiveRun, getActiveRun, subscribeToRun,
  persistUserMessage, persistSubscribeUserMessage, reactivateSubscribeRun,
  abortRun, getRunningSessionIds, type SseEvent,
} from "./active-runs-service.js";
import { listSubagentsForRequesterSession, readSubagentRegistry } from "./subagent-registry-service.js";
import { resolveAgentWorkspacePrefix, resolveActiveAgentId } from "./workspace-service.js";
import {
  bulkDeleteObjectEntries,
  deleteObjectEntry,
  createObjectEntry,
  createObjectField,
  executeObjectAction,
  getObjectActionRuns,
  getObjectDetail,
  getObjectEntryContent,
  getObjectEntryDetail,
  getObjectEntryOptions,
  getObjectViews,
  renameObjectEnumValue,
  renameObjectField,
  reorderObjectFields,
  saveObjectViews,
  setObjectDisplayField,
  deleteObjectField,
  updateObjectEntry,
  writeObjectEntryContent,
} from "./object-service.js";
import {
  createWorkspaceWatchStream,
  executeWorkspaceReport,
  executeWorkspaceSql,
  getLinkPreview,
  getPathInfo,
  getSuggestedFiles,
  getVirtualFile,
  getWorkspaceContext,
  getWorkspaceSearchIndex,
  getWorkspaceTree,
  introspectDatabase,
  queryDatabaseFile,
  runWorkspaceQuery,
  writeBinaryFile,
  writeVirtualFile,
} from "./workspace-discovery-service.js";
import { createWorkspace, deleteWorkspace, getActiveModel, getActiveWorkspaceName, listWorkspaces, switchWorkspace } from "./workspace-service.js";

export function createControlApiApp() {
  const app = new Hono();

  app.use("*", requestIdMiddleware);
  app.use("*", createCorsMiddleware());
  app.use("*", requestLoggerMiddleware);

  app.get("/health", (c) => c.json(getHealthResponse()));
  app.get("/version", (c) => c.json(getVersionResponse()));
  app.get("/capabilities", (c) => c.json(getCapabilitiesResponse(buildControlApiContext(c))));

  app.use("/profiles/*", authMiddleware);
  app.get("/profiles", () => Response.json(listProfilesSummary()));
  app.post("/profiles/switch", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspace?: unknown; profile?: unknown };
    const requestedWorkspace = typeof (body.workspace ?? body.profile) === "string" ? String(body.workspace ?? body.profile) : "";
    if (!requestedWorkspace.trim()) {
      return c.json({ error: "Invalid workspace name. Use letters, numbers, hyphens, or underscores." }, 400);
    }
    try {
      return c.json(switchProfileSummary(requestedWorkspace));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch workspace.";
      if (message.startsWith("Invalid workspace name")) return c.json({ error: message }, 400);
      if (message.includes("was not found")) return c.json({ error: message }, 404);
      return c.json({ error: message }, 500);
    }
  });

  app.use("/model-auth/*", authMiddleware);
  app.get("/model-auth/openai-codex", (c) => c.json(getModelAuthSummary()));
  app.post("/model-auth/openai-codex", () => {
    ensurePrimaryModel();
    return Response.json({ ok: true, ...getModelAuthSummary() });
  });
  app.get("/model-auth/openai-codex/login", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: "Missing 'sessionId'." }, 400);
    }
    const session = getLoginSession(sessionId);
    if (!session) {
      return c.json({ error: "Login session not found." }, 404);
    }
    return c.json({
      ...session,
      currentProfileId: session.profiles.find((profile) => profile.isCurrent)?.id ?? null,
      model: OPENAI_CODEX_MODEL,
      provider: OPENAI_CODEX_PROVIDER,
    });
  });
  app.post("/model-auth/openai-codex/login", () => {
    try {
      const result = startOpenAiCodexLoginSession();
      return Response.json({
        ...result,
        currentProfileId: result.profiles.find((profile) => profile.isCurrent)?.id ?? null,
        model: OPENAI_CODEX_MODEL,
        provider: OPENAI_CODEX_PROVIDER,
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "OpenAI login failed." }, { status: 500 });
    }
  });
  app.post("/model-auth/openai-codex/select", async (c) => {
    const body = await c.req.json().catch(() => null) as { profileId?: string } | null;
    if (!body?.profileId) {
      return c.json({ error: "Missing 'profileId'." }, 400);
    }
    try {
      ensurePrimaryModel();
      const profiles = setSelectedProfile(OPENAI_CODEX_PROVIDER, body.profileId);
      return c.json({
        ok: true,
        provider: OPENAI_CODEX_PROVIDER,
        model: OPENAI_CODEX_MODEL,
        currentProfileId: profiles.find((profile) => profile.isCurrent)?.id ?? null,
        profiles,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to switch OpenAI account." }, 500);
    }
  });
  app.post("/model-auth/openai-codex/disconnect", async (c) => {
    const body = await c.req.json().catch(() => null) as { profileId?: string } | null;
    if (!body?.profileId) {
      return c.json({ error: "Missing 'profileId'." }, 400);
    }
    try {
      const profiles = disconnectProfile(OPENAI_CODEX_PROVIDER, body.profileId);
      return c.json({
        ok: true,
        provider: OPENAI_CODEX_PROVIDER,
        model: OPENAI_CODEX_MODEL,
        currentProfileId: profiles.find((profile) => profile.isCurrent)?.id ?? null,
        profiles,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to disconnect OpenAI account." }, 500);
    }
  });

  app.use("/workspace/*", authMiddleware);
  app.get("/workspace/list", (c) => c.json(listWorkspaces()));
  app.get("/workspace/active-model", (c) => c.json({ model: getActiveModel() }));
  app.get("/workspace/file", (c) => {
    const result = getWorkspaceFile(c.req.query("path") ?? "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/browse", (c) => {
    const result = getBrowseEntries(c.req.query("dir"), c.req.query("showHidden") === "1");
    return c.json(result.data, result.status);
  });
  app.get("/workspace/tree", async (c) => c.json(
    await getWorkspaceTree(c.req.query("showHidden") === "1"),
  ));
  app.get("/workspace/context", (c) => c.json(getWorkspaceContext()));
  app.get("/workspace/search-index", async (c) => c.json(await getWorkspaceSearchIndex()));
  app.get("/workspace/suggest-files", async (c) => c.json(
    await getSuggestedFiles(c.req.query("path"), c.req.query("q")),
  ));
  app.get("/workspace/path-info", async (c) => {
    const result = await getPathInfo(c.req.query("path") ?? "");
    if ("error" in result) {
      return c.json(
        result.path ? { error: result.error, path: result.path } : { error: result.error },
        result.status,
      );
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/browse-file", (c) => {
    const result = getBrowseFile(c.req.query("path") ?? "", c.req.query("raw") === "true");
    if ("error" in result) {
      if ("buffer" in result) {
        return c.body(result.error, result.status);
      }
      return c.json({ error: result.error }, result.status);
    }
    if ("buffer" in result) {
      return new Response(result.buffer, {
        status: result.status,
        headers: {
          "Content-Length": String(result.buffer.length),
          "Content-Type": result.contentType,
        },
      });
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/mkdir", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; absolute?: unknown };
    const result = createDirectory(
      typeof body.path === "string" ? body.path : "",
      body.absolute === true,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/move", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sourcePath?: unknown; destinationDir?: unknown };
    const result = movePath(
      typeof body.sourcePath === "string" ? body.sourcePath : "",
      typeof body.destinationDir === "string" ? body.destinationDir : "",
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/rename", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; newName?: unknown };
    const result = renamePath(
      typeof body.path === "string" ? body.path : "",
      typeof body.newName === "string" ? body.newName : "",
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/copy", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; destinationPath?: unknown };
    const result = copyPath(
      typeof body.path === "string" ? body.path : "",
      typeof body.destinationPath === "string" ? body.destinationPath : undefined,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/file", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; content?: unknown };
    const result = writeWorkspaceFile(
      typeof body.path === "string" ? body.path : "",
      typeof body.content === "string" ? body.content : "",
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.delete("/workspace/file", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown };
    const result = deleteWorkspaceFile(typeof body.path === "string" ? body.path : "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/raw-file", (c) => {
    const result = getRawFile(c.req.query("path") ?? "");
    if ("error" in result) {
      return c.body(result.error, result.status);
    }
    return new Response(result.buffer, {
      status: result.status,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": result.contentType,
      },
    });
  });
  app.post("/workspace/raw-file", async (c) => {
    const path = c.req.query("path") ?? "";
    const buffer = Buffer.from(await c.req.arrayBuffer());
    const result = writeRawFile(path, buffer);
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/upload", async (c) => {
    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Invalid form data" }, 400);
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' field" }, 400);
    }
    const result = await uploadWorkspaceFile(file);
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/assets/*", (c) => {
    const suffix = c.req.path.replace("/workspace/assets/", "");
    const result = getAssetFile(`assets/${suffix}`);
    if ("error" in result) {
      return c.body(result.error, result.status);
    }
    return new Response(result.buffer, {
      status: result.status,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": result.contentType,
      },
    });
  });
  app.post("/workspace/switch", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspace?: unknown };
    try {
      return c.json(switchWorkspace(typeof body.workspace === "string" ? body.workspace : ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch workspace.";
      if (message.startsWith("Invalid workspace name")) {
        return c.json({ error: message }, 400);
      }
      if (message.includes("was not found")) {
        return c.json({ error: message }, 404);
      }
      throw error;
    }
  });
  app.post("/workspace/delete", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspace?: unknown; profile?: unknown };
    try {
      return c.json(deleteWorkspace(typeof (body.workspace ?? body.profile) === "string" ? String(body.workspace ?? body.profile) : ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workspace delete failed.";
      if (message.startsWith("Invalid workspace name")) {
        return c.json({ error: message }, 400);
      }
      if (message.includes("was not found")) {
        return c.json({ error: message }, 404);
      }
      if (message.includes("does not have a directory")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });
  app.post("/workspace/init", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspace?: unknown; profile?: unknown; seedBootstrap?: unknown };
    try {
      return c.json(
        createWorkspace({
          workspaceName: typeof (body.workspace ?? body.profile) === "string" ? String(body.workspace ?? body.profile) : "",
          seedBootstrap: body.seedBootstrap !== false,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create workspace.";
      if (message.includes("required") || message.startsWith("Invalid or reserved")) {
        return c.json({ error: message }, 400);
      }
      if (message.includes("already exists")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });
  app.post("/workspace/write-binary", async (c) => {
    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: "Invalid form data" }, 400);
    }
    const result = await writeBinaryFile(formData);
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/virtual-file", (c) => {
    const result = getVirtualFile(c.req.query("path") ?? "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/virtual-file", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; content?: unknown };
    const result = writeVirtualFile(
      typeof body.path === "string" ? body.path : "",
      typeof body.content === "string" ? body.content : "",
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/query", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sql?: unknown };
    const result = await runWorkspaceQuery(typeof body.sql === "string" ? body.sql : "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/execute", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sql?: unknown };
    const result = await executeWorkspaceSql(typeof body.sql === "string" ? body.sql : "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/reports/execute", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sql?: unknown; filters?: unknown };
    const result = await executeWorkspaceReport(
      typeof body.sql === "string" ? body.sql : "",
      Array.isArray(body.filters) ? body.filters as never : undefined,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/db/introspect", async (c) => {
    const result = await introspectDatabase(c.req.query("path") ?? "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.post("/workspace/db/query", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: unknown; sql?: unknown };
    const result = await queryDatabaseFile(
      typeof body.path === "string" ? body.path : "",
      typeof body.sql === "string" ? body.sql : "",
    );
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });
  app.get("/workspace/watch", async (c) => {
    const result = await createWorkspaceWatchStream(c.req.raw.signal);
    if ("error" in result) {
      return c.body(result.error, result.status);
    }
    return new Response(result.data, {
      status: result.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
  app.get("/workspace/objects/:name/views", async (c) => {
    const data = await getObjectViews(decodeURIComponent(c.req.param("name")));
    return c.json(data);
  });
  app.get("/workspace/objects/:name", async (c) => {
    const result = await getObjectDetail(decodeURIComponent(c.req.param("name")), c.req.url);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.put("/workspace/objects/:name/views", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      views?: unknown;
      activeView?: unknown;
      viewSettings?: unknown;
    };
    const ok = await saveObjectViews(
      decodeURIComponent(c.req.param("name")),
      Array.isArray(body.views) ? body.views as never[] : [],
      typeof body.activeView === "string" ? body.activeView : undefined,
      typeof body.viewSettings === "object" && body.viewSettings !== null ? body.viewSettings as Record<string, unknown> : undefined,
    );
    if (!ok) {
      return c.json({ error: "Object directory not found" }, 404);
    }
    return c.json({ ok: true });
  });
  app.patch("/workspace/objects/:name/display-field", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { displayField?: unknown };
    const result = await setObjectDisplayField(
      decodeURIComponent(c.req.param("name")),
      typeof body.displayField === "string" ? body.displayField : "",
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.patch("/workspace/objects/:name/fields/reorder", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { fieldOrder?: unknown };
    const result = await reorderObjectFields(
      decodeURIComponent(c.req.param("name")),
      Array.isArray(body.fieldOrder) ? body.fieldOrder.filter((value): value is string => typeof value === "string") : [],
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/workspace/objects/:name/fields", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await createObjectField(decodeURIComponent(c.req.param("name")), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.patch("/workspace/objects/:name/fields/:fieldId", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    const result = await renameObjectField(
      decodeURIComponent(c.req.param("name")),
      c.req.param("fieldId"),
      typeof body.name === "string" ? body.name : "",
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.delete("/workspace/objects/:name/fields/:fieldId", async (c) => {
    const result = await deleteObjectField(
      decodeURIComponent(c.req.param("name")),
      c.req.param("fieldId"),
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.patch("/workspace/objects/:name/fields/:fieldId/enum-rename", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { oldValue?: unknown; newValue?: unknown };
    const result = await renameObjectEnumValue(
      decodeURIComponent(c.req.param("name")),
      c.req.param("fieldId"),
      typeof body.oldValue === "string" ? body.oldValue : "",
      typeof body.newValue === "string" ? body.newValue : "",
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/workspace/objects/:name/entries/options", async (c) => {
    const result = await getObjectEntryOptions(
      decodeURIComponent(c.req.param("name")),
      c.req.query("q") ?? "",
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/workspace/objects/:name/entries", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { fields?: unknown };
    const result = await createObjectEntry(
      decodeURIComponent(c.req.param("name")),
      typeof body.fields === "object" && body.fields !== null ? body.fields as Record<string, string> : undefined,
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/workspace/objects/:name/entries/:id", async (c) => {
    const result = await getObjectEntryDetail(
      decodeURIComponent(c.req.param("name")),
      c.req.param("id"),
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.patch("/workspace/objects/:name/entries/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { fields?: unknown };
    const result = await updateObjectEntry(
      decodeURIComponent(c.req.param("name")),
      c.req.param("id"),
      typeof body.fields === "object" && body.fields !== null ? body.fields as Record<string, unknown> : {},
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.delete("/workspace/objects/:name/entries/:id", async (c) => {
    const result = await deleteObjectEntry(
      decodeURIComponent(c.req.param("name")),
      c.req.param("id"),
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/workspace/objects/:name/entries/:id/content", async (c) => {
    const result = await getObjectEntryContent(
      decodeURIComponent(c.req.param("name")),
      c.req.param("id"),
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.put("/workspace/objects/:name/entries/:id/content", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { content?: unknown };
    const result = await writeObjectEntryContent(
      decodeURIComponent(c.req.param("name")),
      c.req.param("id"),
      typeof body.content === "string" ? body.content : "",
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/workspace/objects/:name/entries/bulk-delete", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { entryIds?: unknown };
    const result = await bulkDeleteObjectEntries(
      decodeURIComponent(c.req.param("name")),
      Array.isArray(body.entryIds) ? body.entryIds.filter((value): value is string => typeof value === "string") : [],
    );
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/workspace/objects/:name/actions", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await executeObjectAction(decodeURIComponent(c.req.param("name")), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return new Response(result.data, {
      status: result.status,
      headers: result.headers,
    });
  });
  app.get("/workspace/objects/:name/actions/runs", async (c) => {
    const result = await getObjectActionRuns(decodeURIComponent(c.req.param("name")), {
      actionId: c.req.query("actionId"),
      entryId: c.req.query("entryId"),
      fieldId: c.req.query("fieldId"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/workspace/open-file", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { path?: string; reveal?: boolean };
    const result = await openFile(body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/workspace/thumbnail", (c) => {
    const path = c.req.query("path") ?? "";
    const size = c.req.query("size") ?? "200";
    const result = generateThumbnail(path, size);
    if ("error" in result) return c.body(result.error, result.status);
    return new Response(result.data, {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  });
  app.get("/workspace/link-preview", async (c) => {
    const result = await getLinkPreview(c.req.query("url") ?? "");
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status, {
      "Cache-Control": "public, max-age=86400",
    });
  });

  app.use("/sessions/*", authMiddleware);
  app.get("/sessions", (c) => {
    return c.json(listAllSessions());
  });
  app.get("/sessions/:sessionId", (c) => {
    const result = getSessionTranscript(c.req.param("sessionId"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });

  app.use("/skills", authMiddleware);
  app.get("/skills", (c) => {
    return c.json(listSkills());
  });

  app.use("/memories", authMiddleware);
  app.get("/memories", (c) => {
    return c.json(getMemories());
  });

  app.use("/web-sessions/*", authMiddleware);
  app.use("/web-sessions", authMiddleware);
  app.get("/web-sessions", (c) => {
    const filePath = c.req.query("filePath");
    const includeAll = c.req.query("includeAll") === "true";
    return c.json(listWebSessions(filePath, includeAll));
  });
  app.post("/web-sessions", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = createWebSession(body);
    return c.json(result.data, result.status);
  });
  app.get("/web-sessions/:id", (c) => {
    const result = getWebSession(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.delete("/web-sessions/:id", (c) => {
    const result = deleteWebSession(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.patch("/web-sessions/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = updateWebSession(c.req.param("id"), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/web-sessions/:id/messages", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { messages: Array<Record<string, unknown>>; title?: string };
    const result = upsertWebSessionMessages(c.req.param("id"), body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });

  app.use("/apps/*", authMiddleware);
  app.get("/apps/serve/*", async (c) => {
    const path = c.req.path.replace(/^\/apps\/serve\//, "");
    return serveAppFile(path);
  });
  app.post("/apps/proxy", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { url?: string; method?: string; headers?: Record<string, string>; body?: string };
    const result = await corsProxy(body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/apps/store", (c) => {
    const result = getAppStoreValue(c.req.query("app") ?? "", c.req.query("key"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.post("/apps/store", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { app?: string; key?: string; value?: unknown };
    const result = setAppStoreValue(body.app ?? "", body.key ?? "", body.value);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.delete("/apps/store", (c) => {
    const result = deleteAppStoreValue(c.req.query("app") ?? "", c.req.query("key"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.all("/apps/webhooks/*", async (c) => {
    const key = c.req.path.replace(/^\/apps\/webhooks\//, "");
    const url = new URL(c.req.url);
    const since = url.searchParams.get("since");
    const poll = url.searchParams.get("poll");

    if (c.req.method === "GET" && (poll || since)) {
      const result = getWebhookEvents(key, since ? parseInt(since, 10) : 0);
      return c.json(result.data, result.status);
    }

    if (c.req.method === "GET") {
      // GET without poll/since is treated as incoming webhook
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
    let body = "";
    try { body = await c.req.text(); } catch {}
    const result = handleWebhookIncoming(key, c.req.method, headers, body);
    return c.json(result.data, result.status);
  });

  // Gateway RPC proxy for cron operations (add/remove/enable/disable/run/list)
  app.post("/apps/cron", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { action?: string; params?: Record<string, unknown> };
    const { action, params } = body;
    if (!action || typeof action !== "string") {
      return c.json({ error: "Missing 'action' field" }, 400);
    }
    const ALLOWED_ACTIONS = ["add", "remove", "enable", "disable", "run", "list"];
    if (!ALLOWED_ACTIONS.includes(action)) {
      return c.json({ error: `Invalid action: ${action}` }, 400);
    }
    try {
      const result = await callGatewayRpc(`cron.${action}`, params || {});
      if (result.ok) return c.json({ ok: true, payload: result.payload });
      return c.json({ error: result.error || "RPC failed" }, 500);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Gateway RPC failed" }, 502);
    }
  });

  app.get("/apps/cron", async (c) => {
    try {
      const result = await callGatewayRpc("cron.list", {});
      if (result.ok) return c.json(result.payload);
      return c.json({ error: result.error || "RPC failed" }, 500);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Gateway RPC failed" }, 502);
    }
  });

  app.use("/cron/*", authMiddleware);
  app.get("/cron/jobs", (c) => {
    return c.json(listCronJobs());
  });
  app.post("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = createCronJob(body);
    return c.json(result.data, result.status);
  });
  app.put("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = updateCronJob(body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.delete("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = deleteCronJob(body);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/cron/jobs/:jobId/runs", (c) => {
    const jobId = c.req.param("jobId");
    const limit = Number(c.req.query("limit")) || 100;
    const result = getCronJobRuns(jobId, limit);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/cron/runs/search-transcript", (c) => {
    const jobId = c.req.query("jobId") ?? "";
    const runAtMs = Number(c.req.query("runAtMs"));
    const summary = c.req.query("summary");
    const result = searchCronTranscript(jobId, runAtMs, summary);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });
  app.get("/cron/runs/:sessionId", (c) => {
    const result = getCronRunTranscript(c.req.param("sessionId"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });

  app.use("/gateway/*", authMiddleware);
  app.get("/gateway/channels", async (c) => {
    return c.json(await getGatewayChannels());
  });
  app.get("/gateway/sessions", (c) => {
    return c.json(getGatewaySessions(getActiveWorkspaceName() === "default" ? "main" : (getActiveWorkspaceName() ?? "main"), c.req.query("channel")));
  });
  app.get("/gateway/sessions/:id", (c) => {
    const result = getGatewaySessionMessages(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data, result.status);
  });

  // ── Chat & Streaming ──

  app.use("/chat/*", authMiddleware);

  // Helper: create SSE ReadableStream from run subscription
  function createSseStream(
    runKey: string,
    options: { replay: boolean; normalize?: boolean },
  ): ReadableStream<Uint8Array> | null {
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const normalizeLiveStreamEvent = (event: SseEvent): SseEvent => {
      if (options.normalize && event.type === "tool-output-partial") {
        return { type: "tool-output-available", toolCallId: event.toolCallId, output: event.output, preliminary: true };
      }
      return event;
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        keepalive = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* ignore */ }
        }, 15_000);

        unsubscribe = subscribeToRun(runKey, (event: SseEvent | null) => {
          if (closed) return;
          if (event === null) {
            closed = true;
            if (keepalive) { clearInterval(keepalive); keepalive = null; }
            try { controller.close(); } catch { /* already closed */ }
            return;
          }
          try {
            const json = JSON.stringify(normalizeLiveStreamEvent(event));
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
          } catch { /* ignore */ }
        }, { replay: options.replay });

        if (!unsubscribe) {
          closed = true;
          if (keepalive) { clearInterval(keepalive); keepalive = null; }
          controller.close();
        }
      },
      cancel() {
        closed = true;
        if (keepalive) { clearInterval(keepalive); keepalive = null; }
        unsubscribe?.();
      },
    });

    return stream;
  }

  function sseResponse(stream: ReadableStream<Uint8Array>, extraHeaders?: Record<string, string>): Response {
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        ...extraHeaders,
      },
    });
  }

  function deriveSubagentInfo(sessionKey: string): { parentSessionId: string; task: string } | null {
    const entries = readSubagentRegistry();
    for (const entry of entries) {
      if (entry.childSessionKey !== sessionKey) continue;
      const match = entry.requesterSessionKey.match(/^agent:[^:]+:web:(.+)$/);
      const parentSessionId = match?.[1] ?? "";
      return { parentSessionId, task: entry.task ?? "" };
    }
    return null;
  }

  // POST /chat — start a new agent run and stream SSE
  app.post("/chat", async (c) => {
    const body = await c.req.json() as {
      messages?: Array<{ role: string; id?: string; parts?: Array<{ type: string; text?: string }> }>;
      sessionId?: string;
      sessionKey?: string;
      userHtml?: string;
    };

    const { messages = [], sessionId, sessionKey, userHtml } = body;
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    const userText = lastUserMessage?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text).join("\n") ?? "";

    if (!userText.trim()) return c.text("No message provided", 400);

    const isSubagentSession = typeof sessionKey === "string" && sessionKey.includes(":subagent:");

    if (!isSubagentSession && sessionId && hasActiveRun(sessionId)) {
      return c.text("Active run in progress", 409);
    }
    if (isSubagentSession && sessionKey) {
      const existingRun = getActiveRun(sessionKey);
      if (existingRun?.status === "running") return c.text("Active subagent run in progress", 409);
    }

    let agentMessage = userText;
    const wsPrefix = resolveAgentWorkspacePrefix();
    if (wsPrefix) {
      agentMessage = userText.replace(
        /\[Context: workspace file '([^']+)'\]/,
        `[Context: workspace file '${wsPrefix}/$1']`,
      );
    }

    const runKey = isSubagentSession && sessionKey ? sessionKey : (sessionId as string);

    if (isSubagentSession && sessionKey && lastUserMessage) {
      let run = getActiveRun(sessionKey);
      if (!run) {
        const info = deriveSubagentInfo(sessionKey);
        if (!info) return c.text("Subagent not found", 404);
        run = startSubscribeRun({ sessionKey, parentSessionId: info.parentSessionId, task: info.task });
      }
      await persistSubscribeUserMessage(sessionKey, { id: lastUserMessage.id, text: userText });
      reactivateSubscribeRun(sessionKey, agentMessage);
    } else if (sessionId && lastUserMessage) {
      await persistUserMessage(sessionId, {
        id: lastUserMessage.id ?? `user-${Date.now()}`,
        content: userText,
        parts: lastUserMessage.parts as unknown[],
        html: userHtml,
      });
      const sessionMeta = getSessionMeta(sessionId);
      const effectiveAgentId = sessionMeta?.workspaceAgentId ?? resolveActiveAgentId();
      try {
        startRun({ sessionId, message: agentMessage, agentSessionId: sessionId, overrideAgentId: effectiveAgentId });
      } catch (err) {
        return c.text(err instanceof Error ? err.message : String(err), 500);
      }
    }

    if (!runKey) return c.text("No session key", 400);
    const stream = createSseStream(runKey, { replay: false, normalize: true });
    if (!stream) return c.text("No active run", 404);
    return sseResponse(stream);
  });

  // GET /chat/stream — reconnect to active/recent run
  app.get("/chat/stream", (c) => {
    const sessionId = c.req.query("sessionId");
    const sessionKey = c.req.query("sessionKey");
    const isSubagentSession = typeof sessionKey === "string" && sessionKey.includes(":subagent:");

    if (!sessionId && !sessionKey) return c.text("sessionId or sessionKey required", 400);
    const runKey = isSubagentSession && sessionKey ? sessionKey : (sessionId as string);

    let run = getActiveRun(runKey);
    if (!run && isSubagentSession && sessionKey) {
      const info = deriveSubagentInfo(sessionKey);
      if (info) run = startSubscribeRun({ sessionKey, parentSessionId: info.parentSessionId, task: info.task });
    }
    if (!run) return c.json({ active: false }, 404);

    const stream = createSseStream(runKey, { replay: true });
    if (!stream) return c.json({ active: false }, 404);
    return sseResponse(stream, {
      "X-Run-Active": run.status === "running" || run.status === "waiting-for-subagents" ? "true" : "false",
    });
  });

  // GET /chat/active — running session IDs
  app.get("/chat/active", (c) => c.json({ sessionIds: getRunningSessionIds() }));

  // POST /chat/stop — abort a run
  app.post("/chat/stop", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: string; sessionKey?: string; cascadeChildren?: boolean;
    };
    const isSubagentSession = typeof body.sessionKey === "string" && body.sessionKey.includes(":subagent:");
    const runKey = isSubagentSession && body.sessionKey ? body.sessionKey : body.sessionId;
    if (!runKey) return c.text("sessionId or sessionKey required", 400);

    const run = getActiveRun(runKey);
    const canAbort = run?.status === "running" || run?.status === "waiting-for-subagents";
    const aborted = canAbort ? abortRun(runKey) : false;
    let abortedChildren = 0;

    if (!isSubagentSession && body.sessionId && body.cascadeChildren) {
      const fallbackAgentId = resolveActiveAgentId();
      const requesterKey = resolveSessionKey(body.sessionId, fallbackAgentId);
      for (const subagent of listSubagentsForRequesterSession(requesterKey)) {
        const childRun = getActiveRun(subagent.childSessionKey);
        const canAbortChild = childRun?.status === "running" || childRun?.status === "waiting-for-subagents";
        if (canAbortChild && abortRun(subagent.childSessionKey)) abortedChildren += 1;
      }
    }

    return c.json({ aborted, abortedChildren });
  });

  // GET /chat/runs — parent runs + subagents
  app.get("/chat/runs", (c) => {
    const sessions = readIndex();
    const fallbackAgentId = resolveActiveAgentId();
    const parentSessionKeys = new Map(sessions.map((s) => [resolveSessionKey(s.id, fallbackAgentId), s.id]));

    const parentRuns = sessions
      .map((session) => {
        const run = getActiveRun(session.id);
        if (!run) return null;
        return { sessionId: session.id, status: run.status };
      })
      .filter((run): run is { sessionId: string; status: string } => Boolean(run));

    const subagents = [...parentSessionKeys.entries()]
      .flatMap(([requesterSessionKey, parentSessionId]) =>
        listSubagentsForRequesterSession(requesterSessionKey).map((entry) => ({
          childSessionKey: entry.childSessionKey, parentSessionId,
          runId: entry.runId, task: entry.task, label: entry.label || undefined,
          status: entry.status, startedAt: entry.createdAt, endedAt: entry.endedAt,
        })),
      )
      .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    return c.json({ parentRuns, subagents });
  });

  // GET /chat/subagents — subagents for a session
  app.get("/chat/subagents", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);

    const run = getActiveRun(sessionId);
    const fallbackAgentId = resolveActiveAgentId();
    const webSessionKey = run?.pinnedSessionKey ?? resolveSessionKey(sessionId, fallbackAgentId);
    const entries = readSubagentRegistry();

    const subagents = entries
      .filter((e) => e.requesterSessionKey === webSessionKey)
      .map((e) => ({
        sessionKey: e.childSessionKey, runId: e.runId, task: e.task,
        label: e.label || undefined,
        status: (typeof e.endedAt !== "number" ? "running" : e.outcome?.status === "error" ? "error" : "completed") as string,
        startedAt: e.createdAt, endedAt: e.endedAt,
      }))
      .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    return c.json({ subagents });
  });

  // GET /terminal/port — return terminal WebSocket connection info
  app.get("/terminal/port", (c) => {
    const proxy = process.env.DENCHCLAW_DAEMONLESS === "1";
    // Expose the public control-api URL so the browser can build ws(s):// URLs
    const controlApiBaseUrl = process.env.CONTROL_API_PUBLIC_URL || "";
    return c.json({ port: null, proxy, wsPath: TERMINAL_WS_PATH, controlApiBaseUrl });
  });

  // POST /feedback — capture $ai_trace for PostHog on thumbs up/down
  app.post("/feedback", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: string;
      messageId?: string;
      distinctId?: string;
    };
    return c.json(submitFeedback(body));
  });

  // ── Gateway Chat (channel sessions) ──

  app.use("/gateway/chat/*", authMiddleware);

  // POST /gateway/chat — send message to channel session
  app.post("/gateway/chat", async (c) => {
    const { sessionKey, message } = await c.req.json() as { sessionKey?: string; message?: string };
    if (!sessionKey || !message?.trim()) return c.text("sessionKey and message are required", 400);

    let run = getActiveRun(sessionKey);
    if (run?.status === "running") return c.text("Active run already in progress", 409);

    if (run) {
      reactivateSubscribeRun(sessionKey, message);
    } else {
      const sessionLabel = sessionKey.split(":").slice(2).join(":");
      run = startSubscribeRun({ sessionKey, parentSessionId: sessionKey, task: message.slice(0, 200), label: sessionLabel });
      reactivateSubscribeRun(sessionKey, message);
    }

    const stream = createSseStream(sessionKey, { replay: false });
    if (!stream) return c.text("No active run", 404);
    return sseResponse(stream);
  });

  // GET /gateway/chat/stream — channel session event stream
  app.get("/gateway/chat/stream", (c) => {
    const sessionKey = c.req.query("sessionKey");
    if (!sessionKey) return c.text("sessionKey required", 400);

    let run = getActiveRun(sessionKey);
    if (!run) {
      const sessionLabel = sessionKey.split(":").slice(2).join(":");
      run = startSubscribeRun({ sessionKey, parentSessionId: sessionKey, task: `Channel session: ${sessionLabel}`, label: sessionLabel });
    }
    if (!run) return c.json({ active: false }, 404);

    const stream = createSseStream(sessionKey, { replay: true });
    if (!stream) return c.json({ active: false }, 404);
    return sseResponse(stream, {
      "X-Run-Active": run.status === "running" || run.status === "waiting-for-subagents" ? "true" : "false",
    });
  });

  app.use("/trpc/*", authMiddleware);
  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: ({ hono: c }) => buildControlApiContext(c),
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    console.error(
      JSON.stringify({
        error: error.message,
        path: c.req.path,
        requestId: c.get("requestId"),
        type: "error",
      }),
    );

    return c.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected control-api error.",
        },
      },
      500,
    );
  });

  return app;
}
