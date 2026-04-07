import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const upstream = await fetchControlApi(`/web-sessions/${encodeURIComponent(id)}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ error: "Failed to load session" }));
  return Response.json(data, { status: upstream.status });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const upstream = await fetchControlApi(`/web-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await upstream.json().catch(() => ({ error: "Failed to delete session" }));
  return Response.json(data, { status: upstream.status });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const upstream = await fetchControlApi(`/web-sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to update session" }));
  return Response.json(data, { status: upstream.status });
}
