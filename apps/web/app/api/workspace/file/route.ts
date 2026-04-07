import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/file?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to load file." }));
  return Response.json(data, { status: upstream.status });
}

/**
 * POST /api/workspace/file
 * Body: { path: string, content: string }
 *
 * Writes a file to the workspace. Creates parent directories as needed.
 */
export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/workspace/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Write failed" }));
  return Response.json(data, { status: upstream.status });
}

/**
 * DELETE /api/workspace/file
 * Body: { path: string }
 *
 * Deletes a file or folder from the workspace.
 * System files (.object.yaml, workspace.duckdb, etc.) are protected.
 */
export async function DELETE(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/workspace/file", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Delete failed" }));
  return Response.json(data, { status: upstream.status });
}
