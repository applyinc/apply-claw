import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const upstream = await fetchControlApi(`/cron/runs/${encodeURIComponent(sessionId)}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ error: "Failed to load transcript" }));
  return Response.json(data, { status: upstream.status });
}
