import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/workspace/upload
 * Accepts multipart form data with a "file" field.
 * Saves to assets/<timestamp>-<filename> inside the workspace.
 * Returns { ok, path } where path is workspace-relative.
 */
export async function POST(req: Request) {
  const formData = await req.formData();
  const upstream = await fetchControlApi("/workspace/upload", {
    method: "POST",
    body: formData,
  });
  const data = await upstream.json().catch(() => ({ error: "Upload failed" }));
  return Response.json(data, { status: upstream.status });
}
