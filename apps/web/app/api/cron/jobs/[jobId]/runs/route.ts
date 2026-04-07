import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") ?? "100";
  const upstream = await fetchControlApi(`/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ entries: [] }));
  return Response.json(data, { status: upstream.status });
}
