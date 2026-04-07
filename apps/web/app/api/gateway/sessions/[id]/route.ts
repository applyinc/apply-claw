import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const upstream = await fetchControlApi(`/gateway/sessions/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ error: "Session not found" }));
  return Response.json(data, { status: upstream.status });
}
